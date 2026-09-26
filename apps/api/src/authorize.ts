/**
 * The decision plane's pipeline: `authorize`, and nothing past it.
 *
 * This is the file where the architecture either holds or does not. Every package
 * below it has been tested on its own — the kernel, the reservation, the ticket, the
 * approval — and the claim that actually matters is about the *order*: evaluation
 * before reservation, reservation before decision row, decision row before ticket
 * (refused by a trigger, not by convention), approval spent before anything is
 * authorised twice, and a denial that leaves no ticket to redeem. None of that is
 * visible from inside a single package.
 *
 * Two boundaries are visible from here. `authorize` stops at the ticket: it holds no
 * signing key and cannot ask a provider for a signature, because `apps/signer` does
 * that (§2). And the whole exchange runs in one tenant transaction, so the
 * reservation, the decision row, the audit events and the ticket either all exist or
 * none do — which is what makes A9's "the signer was never reached" observable rather
 * than inferred.
 */

import { appendEvent } from '@ari/audit';
import { ApprovalKey, requestApproval, spendApproval } from '@ari/approvals';
import {
  activeScopes,
  asTenant,
  recordRequest,
  recipientFirstSeenAt,
  requestStateOf,
  resolveGrant,
  setRequestState,
  type Connector,
  type TenantTx,
} from '@ari/identity';
import { claimTicket, mintTicket, readCounter, recordDecision, release, releaseForRequest, reserve, settleForRequest } from '@ari/ledger';
import { evaluate, type CompiledPolicy, type EvaluationState } from '@ari/policy-engine';
import { loadVersion, type StoredVersion } from '@ari/policies';
import { Decision, type AuthorizationTicket, type CandidateTransaction, type ReasonCode } from '@ari/schemas';
import { TicketKey, claimsFor, sealTicket } from '@ari/signing';
import type { RiskProvider } from '@ari/risk-engine';
import { canTransition, canonicalize, computeDigest, LifecycleState } from '@ari/transaction-engine';

export interface PipelineDeps {
  readonly pool: Connector;
  /**
   * Two seals, not one shared secret. A ticket goes to a signer process and an
   * approval token goes to a human's browser; one key for both means rotating
   * either invalidates the other, which is the kind of coupling that turns a
   * routine rotation into an outage.
   */
  readonly ticketKey: TicketKey;
  readonly approvalKey: ApprovalKey;
  /** Out of the pipeline's hands entirely — the gateway verifies, this evaluates. */
  readonly masterPepper: string;
  readonly nowMs: () => bigint;
  /**
   * Required, not optional. `evaluate` treats a missing assessment as the fallback the
   * policy named, and every shipped policy names `escalate` — so a composition root
   * that "forgot" an optional risk provider would send every payment to a human, and
   * the field being mandatory is what makes the decision plane say which engine it
   * consulted rather than defaulting into silence. `apps/api` wires the behavioural
   * provider, which needs no external service: it aggregates Ari's own history.
   */
  readonly risk: RiskProvider;
}

export interface AuthorizeInput {
  readonly credentialId: string;
  readonly agentId: string;
  readonly candidate: CandidateTransaction;
  readonly idempotencyKey: string;
  /** Present on the second pass, after a human has approved. */
  readonly approvalToken?: string;
  /**
   * Evaluation only. `§3` is explicit that `evaluate` is a *preview* — it reserves
   * nothing and mints no ticket, so a limit shown as available here may be gone by
   * the time `authorize` asks. Saying so in the response beats pretending the two
   * calls are the same thing.
   */
  readonly dryRun?: boolean;
}

export type AuthorizeOutcome =
  | {
      readonly status: 'TICKET_ISSUED';
      readonly requestId: string;
      readonly ticket: AuthorizationTicket;
      readonly ticketId: string;
      readonly digest: string;
      /** Not a secret and not a capability: the bytes the digest commits to. */
      readonly canonical: string;
    }
  | { readonly status: 'DECIDED'; readonly requestId: string; readonly decision: Decision }
  | {
      readonly status: 'AWAITING_APPROVAL';
      readonly requestId: string;
      readonly approvalId: string;
      readonly expiresAt: string;
    }
  | { readonly status: 'DENIED'; readonly requestId: string; readonly codes: readonly ReasonCode[] }
  | { readonly status: 'REFUSED'; readonly requestId: string; readonly reason: string };

/**
 * The counter's window key: the UTC day.
 *
 * Stated rather than inherited from whichever date function was nearest to hand.
 * A daily cap that resets at midnight is a different promise from a rolling
 * twenty-four hours, and an operator reading a refusal is entitled to know which one
 * they hit.
 */
function dayWindow(nowMs: bigint): string {
  return new Date(Number(nowMs)).toISOString().slice(0, 10);
}

/**
 * The reservation dimension, named by the unit it bounds.
 *
 * A dimension string that omits the unit is how a USDC ceiling and a WEI ceiling end
 * up sharing one counter — the same class of bug §7.1's unit-qualified limits exist
 * to prevent, arriving from the storage side.
 */
/**
 * The month's window key, stated the same way: a UTC calendar month, not a rolling
 * thirty days. A monthly limit that reset on a sliding window would be a different
 * promise from the one the policy sentence makes, and an operator comparing this
 * month's spend to `perMonth` would be reading two different clocks.
 */
function monthWindow(nowMs: bigint): string {
  return new Date(Number(nowMs)).toISOString().slice(0, 7);
}

function dimensionFor(policy: CompiledPolicy): string {
  return `daily_${policy.transfers.amountUnit}`;
}

function monthDimensionFor(policy: CompiledPolicy): string {
  return `monthly_${policy.transfers.amountUnit}`;
}

/**
 * The behavioural baseline, as far as it honestly exists today.
 *
 * Recipients come from transactions that actually *settled*. Chains and assets come
 * from the policy's own declared set, which is not a behavioural profile — it is the
 * narrowest defensible substitute until Phase 5 lands. Saying that here is the
 * difference between a baseline and a number that reads like one.
 */
async function historyOf(
  tx: TenantTx,
  walletId: string,
  policy: CompiledPolicy,
  recipientAddress: string | null,
): Promise<EvaluationState['history']> {
  // Read only when a rule in this policy could ask. A tenant that has never written
  // `recipient_first_seen_within_days` should not pay one query per request for it, and
  // the check is over the compiled policy rather than a flag someone may forget to set.
  const asked = policy.escalation.some((condition) => condition.op === 'recipient_first_seen_within_days');
  return {
    baselineAssets: policy.transfers.assets,
    baselineChains: policy.transfers.chains,
    recipientFirstSeenAtMs:
      asked && recipientAddress !== null ? await recipientFirstSeenAt(tx, { walletId, address: recipientAddress }) : null,
  };
}

/** The approval already open on this request, if one is. */
async function existingApproval(
  tx: TenantTx,
  requestId: string,
): Promise<{ readonly id: string; readonly expiresAt: string } | null> {
  const rows = await tx.client.query<{ id: string; expires_at: Date }>(
    `SELECT id, expires_at FROM ari.approval_requests
      WHERE subject_id = $1 AND org_id = $2 AND status IN ('PENDING', 'GRANTED')
      ORDER BY created_at DESC LIMIT 1`,
    [requestId, tx.orgId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : { id: row.id, expiresAt: row.expires_at.toISOString() };
}

async function usageOf(tx: TenantTx, orgId: string, policy: CompiledPolicy, agentId: string, nowMs: bigint) {
  const counter = await readCounter(tx.client, {
    orgId,
    agentId,
    windowKey: dayWindow(nowMs),
    dimension: dimensionFor(policy),
  });
  // Only read when the policy actually has a monthly ceiling. The alternative was a
  // `reservedMonthRaw: 0n` constant that the kernel dutifully compared against
  // `perMonth`, which made every monthly limit in the schema a field a human could write
  // that did nothing.
  const month =
    policy.transfers.perMonthRaw === null
      ? null
      : await readCounter(tx.client, {
          orgId,
          agentId,
          windowKey: monthWindow(nowMs),
          dimension: monthDimensionFor(policy),
        });
  const recent = await tx.client.query<{ count: string }>(
    `SELECT count(*) AS count FROM ari.transaction_requests
      WHERE agent_id = $1 AND org_id = $2 AND created_at > to_timestamp($3 / 1000.0)`,
    [agentId, orgId, Number(nowMs - 3_600_000n)],
  );
  // `settled` is added to each window because settled money has *left* the account: it
  // is no longer in `current_reserved`, and a daily cap that forgot it would reset
  // itself every time a payment completed. `ikaSpentTodayRaw` stays zero — there is no
  // Ika provider yet, so there is no protocol-fee ledger to read; see AGENTS.md, and do
  // not let a policy come to depend on a number that is a placeholder.
  return {
    reservedDayRaw: (counter?.reservedRaw ?? 0n) + (counter?.settledRaw ?? 0n),
    reservedMonthRaw: month === null ? 0n : month.reservedRaw + month.settledRaw,
    transactionsLastHour: Number(recent.rows[0]?.count ?? '0'),
    ikaSpentTodayRaw: 0n,
  } satisfies EvaluationState['usage'];
}

function denied(codes: readonly ReasonCode[], requestId: string): AuthorizeOutcome {
  return { status: 'DENIED', requestId, codes };
}

async function within(
  deps: PipelineDeps,
  tx: TenantTx,
  orgId: string,
  input: AuthorizeInput,
): Promise<AuthorizeOutcome> {
  const requestId = input.candidate.requestId;
  const grant = await resolveGrant(tx, { agentId: input.agentId, walletId: input.candidate.walletId });
  if (grant === null) return { status: 'REFUSED', requestId, reason: 'no unrevoked grant for this agent and wallet' };
  if (grant.agentStatus !== 'ACTIVE') {
    return denied([grant.agentStatus === 'REVOKED' ? 'AGENT_REVOKED' : 'AGENT_PAUSED'], requestId);
  }

  const version = await loadVersion(tx, grant.policyVersionId);
  if (version === null || version.status !== 'ACTIVE') {
    return { status: 'REFUSED', requestId, reason: 'the governing policy version is not active' };
  }
  const policy = version.compiled;

  return evaluateAndIssue(deps, tx, orgId, input, version, policy);
}

/**
 * Canonicalise, evaluate, and then do exactly one of three things.
 *
 * The lifecycle is walked, not jumped: `DRAFT → VALIDATED → EVALUATING` before any
 * outcome, because the state machine in `transaction-engine` is the record of *how*
 * a request reached its answer, and a pipeline that writes `RESERVED` directly onto
 * a `DRAFT` row has skipped the part an auditor later asks about.
 */
async function evaluateAndIssue(
  deps: PipelineDeps,
  tx: TenantTx,
  orgId: string,
  input: AuthorizeInput,
  version: StoredVersion,
  policy: CompiledPolicy,
): Promise<AuthorizeOutcome> {
  const nowMs = deps.nowMs();
  const context = { policyVersionId: version.id };
  const canonical = canonicalize(input.candidate, context);
  const digest = computeDigest(input.candidate, context);
  const isTransfer = input.candidate.kind === 'transfer';
  const amountRaw = isTransfer && input.candidate.kind === 'transfer' ? input.candidate.amount.raw : 0n;
  const scopes = await activeScopes(tx, input.credentialId);
  const usage = await usageOf(tx, orgId, policy, input.agentId, nowMs);
  const history = await historyOf(
    tx,
    input.candidate.walletId,
    policy,
    input.candidate.kind === 'transfer' ? input.candidate.recipient.address : null,
  );

  /**
   * The subject the risk plane reads, and the request id the kernel echoes.
   *
   * Both are the *caller's* `req_` id, not the row's `txr_` id. An assessment and a
   * decision describe a submitted request — that is what an approver is looking at and
   * what a replayed attempt keeps constant — while everything Ari persists (the request
   * row, the decision row, the audit event, the ticket) is keyed by the row. The two
   * ids look alike, are minted by different code, and only one of them satisfies
   * `Decision.requestId`; the preview path has always used the caller's, which is why
   * the divergence was invisible until the risk plane started parsing its own output.
   */
  const subjectFor = () => ({
    requestId: input.candidate.requestId,
    idempotencyKey: input.idempotencyKey,
    agentId: input.agentId,
    walletId: input.candidate.walletId,
    nowMs,
    amountRaw,
    currencyUnit: policy.transfers.amountUnit,
    recipientAddress: input.candidate.kind === 'transfer' ? input.candidate.recipient.address : null,
    perTransactionCapRaw: policy.transfers.perTransactionRaw,
  });

  // One evaluation, whichever path takes it. The dry run reads the same compiled
  // policy, the same counters and the same baselines, and returns the same decision
  // record — the only thing it withholds is the write.
  const assessment = (risk: EvaluationState['risk']): EvaluationState => ({
    nowMs,
    requestId: input.candidate.requestId,
    agentId: input.agentId,
    agentStatus: 'ACTIVE',
    scopes: [...scopes],
    usage,
    history,
    risk,
    simulation: null,
  });

  if (input.dryRun === true) {
    // No request row, no reservation, no ticket, and no audit event either: §3
    // calls this a preview, and a preview that leaves a trace behind becomes a
    // second source of truth about what was asked.
    const previewRisk = await deps.risk.assess(tx, subjectFor());
    return {
      status: 'DECIDED',
      requestId: input.candidate.requestId,
      decision: evaluate({
        policy,
        candidate: input.candidate,
        state: assessment(previewRisk.ok ? previewRisk.assessment : null),
      }),
    };
  }

  const stored = await recordRequest(tx, {
    agentId: input.agentId,
    walletId: input.candidate.walletId,
    idempotencyKey: input.idempotencyKey,
    canonical,
    digest,
    ...(isTransfer && input.candidate.kind === 'transfer'
      ? {
          recipientAddress: input.candidate.recipient.address,
          amountRaw,
          currencyUnit: input.candidate.amount.unit,
        }
      : {}),
  });
  const requestId = stored.id;
  if (stored.reused && input.approvalToken === undefined) {
    // A retry, and the only safe answer is the one already given.
    //
    // Without this branch the second call reserves again — the ledger's own
    // idempotency key returns the first hold rather than taking a second, but the
    // pipeline would then walk on and mint *another* ticket against it, which is a
    // double spend produced by nothing more adversarial than a client timing out and
    // trying again. §9's promise is that a retry returns the same decision; this is
    // where that is kept.
    return replay(tx, orgId, input, requestId, deps);
  }

  // The lifecycle is walked, never teleported to. A retry arrives on a row that is
  // already partway along — `APPROVAL_PENDING`, usually — and re-running the early
  // transitions would fail on it, so the walk starts where the row already is. That
  // state came back with the row: `recordRequest` knows whether it inserted or found,
  // and reading it again was a query for something already in hand.
  const current = stored.lifecycleState;
  let from = current;
  if (current === 'DRAFT') {
    await setRequestState(tx, { requestId, from: 'DRAFT', to: 'VALIDATED', actor: input.agentId });
    await setRequestState(tx, { requestId, from: 'VALIDATED', to: 'EVALUATING', actor: 'system' });
    from = 'EVALUATING';
  }

  // The risk plane is consulted before the kernel, never inside it: the kernel stays
  // pure (§7.2), so an assessment arrives as one more input in `state`, and the
  // fallback for its absence is the policy's own decision rather than this file's.
  const riskOutcome = await deps.risk.assess(tx, subjectFor());
  await appendEvent(tx, {
    orgId,
    actor: 'system',
    actorType: 'system',
    eventType: riskOutcome.ok ? 'risk.assessed' : 'risk.unavailable',
    resource: 'transaction_request',
    resourceId: requestId,
    policyVersionId: version.id,
    ...(riskOutcome.ok
      ? {
          metadata: {
            riskScore: String(riskOutcome.assessment.score),
            riskLevel: riskOutcome.assessment.level,
            riskSignals: [...riskOutcome.assessment.signals],
            riskModel: riskOutcome.assessment.modelVersion,
          },
        }
      : { severity: 'warning' as const, reasonCodes: ['RISK_ENGINE_UNAVAILABLE'], metadata: { code: riskOutcome.code, detail: riskOutcome.detail } }),
  });

  const decision = evaluate({
    policy,
    candidate: input.candidate,
    state: assessment(riskOutcome.ok ? riskOutcome.assessment : null),
  });
  // The spine reads its own kernel's output back through the published contract before
  // acting on it. `evaluate` returns a structurally-typed object and TypeScript stops
  // there; the first time a field disagreed with `Decision` — a `txr_` id where the
  // contract says `req_` — nothing downstream would have noticed, because the decision's
  // request id is only ever read by whoever audits it afterwards. A throw rolls the
  // transaction back, which is the only acceptable reading of "the decision is not a
  // decision".
  const shaped = Decision.safeParse(decision);
  if (!shaped.success) {
    throw new Error(`the kernel returned something that is not a Decision: ${shaped.error.message.slice(0, 300)}`);
  }

  await appendEvent(tx, {
    orgId,
    actor: input.agentId,
    actorType: 'agent',
    eventType: 'policy.evaluated',
    resource: 'transaction_request',
    resourceId: requestId,
    policyVersionId: version.id,
    decision: decision.outcome,
    reasonCodes: decision.reasonCodes,
    metadata: { digestRef: digest.slice(0, 24), assetUnit: policy.transfers.amountUnit },
  });

  if (decision.outcome === 'DENY') {
    await setRequestState(tx, { requestId, from, to: 'DENIED', actor: 'system' });
    return denied(decision.reasonCodes, requestId);
  }

  if (decision.outcome === 'REQUIRE_HUMAN_APPROVAL' && input.approvalToken === undefined) {
    // A retry without a token gets the pending approval that already exists rather
    // than a second one: two open approvals on one request is two ways to satisfy
    // the same quorum.
    const pending = await existingApproval(tx, requestId);
    if (pending !== null) {
      return { status: 'AWAITING_APPROVAL', requestId, approvalId: pending.id, expiresAt: pending.expiresAt };
    }
    const opened = await requestApproval(tx, {
      subjectKind: 'transaction',
      subjectId: requestId,
      requestId,
      digest,
      policyVersionId: version.id,
      agentId: input.agentId,
      walletId: input.candidate.walletId,
      amountRaw,
      currencyUnit: policy.transfers.amountUnit,
      quorumNeeded: policy.approval.quorum,
      allowedRoles: policy.approval.approverRoles,
      requestedBy: input.credentialId,
      ttlMs: BigInt(policy.validity.ttlSeconds * 1000),
      key: deps.approvalKey,
    });
    await setRequestState(tx, { requestId, from, to: 'APPROVAL_PENDING', actor: 'system' });
    return { status: 'AWAITING_APPROVAL', requestId, approvalId: opened.approvalId, expiresAt: opened.expiresAt };
  }

  if (input.approvalToken !== undefined) {
    const spent = await spendApproval(tx, input.approvalToken, digest, deps.approvalKey);
    if (spent.ok && from === 'APPROVAL_PENDING') {
      await setRequestState(tx, { requestId, from: 'APPROVAL_PENDING', to: 'APPROVAL_GRANTED', actor: 'system' });
      from = 'APPROVAL_GRANTED';
    }
    if (!spent.ok) {
      await appendEvent(tx, {
        orgId,
        actor: input.agentId,
        actorType: 'agent',
        eventType: 'approval.claim_refused',
        resource: 'transaction_request',
        resourceId: requestId,
        severity: 'critical',
        reasonCodes: [spent.code],
        metadata: { code: spent.code, detail: spent.detail.slice(0, 500) },
      });
      await setRequestState(tx, { requestId, from, to: 'DENIED', actor: 'system' });
      return denied([spent.code], requestId);
    }
  }

  return issue(deps, tx, orgId, input, {
    requestId,
    canonical,
    digest,
    version,
    policy,
    amountRaw,
    decision,
    from,
  });
}

interface IssueArgs {
  readonly requestId: string;
  readonly canonical: string;
  readonly digest: ReturnType<typeof computeDigest>;
  readonly version: StoredVersion;
  readonly policy: CompiledPolicy;
  readonly amountRaw: bigint;
  readonly decision: Decision;
  readonly from: string;
}

/**
 * Reserve, decide, ticket.
 *
 * The reservation is first because it is the only step that can be wrong under
 * concurrency; the decision row precedes the ticket because
 * `002_decisions_and_tickets.sql` refuses a ticket with no ALLOW behind it; and the
 * ticket's id is the ledger row's id, because a seal the database cannot resolve to
 * a decision is a token for nothing.
 */
async function issue(
  deps: PipelineDeps,
  tx: TenantTx,
  orgId: string,
  input: AuthorizeInput,
  args: IssueArgs,
): Promise<AuthorizeOutcome> {
  const held = await reserve(tx, {
    orgId,
    agentId: input.agentId,
    windowKey: dayWindow(deps.nowMs()),
    dimension: dimensionFor(args.policy),
    amountRaw: args.amountRaw,
    maxRaw: args.policy.transfers.perDayRaw,
    requestId: args.requestId,
    idempotencyKey: input.idempotencyKey,
    policyVersionId: args.version.id,
  });

  // The month window is taken after the day and released back if it refuses, rather
  // than the other way round: the two guards are the same statement shape, and a
  // monthly refusal must not leave a daily hold parked behind it. This is the ledger's
  // own check — the kernel already refused an over-month request a moment earlier — so
  // reaching it means two requests raced into the same window.
  const dailyHold = held.status === 'HELD' ? held.reservationId : null;
  const monthly =
    dailyHold !== null && args.policy.transfers.perMonthRaw !== null
      ? await reserve(tx, {
          orgId,
          agentId: input.agentId,
          windowKey: monthWindow(deps.nowMs()),
          dimension: monthDimensionFor(args.policy),
          amountRaw: args.amountRaw,
          maxRaw: args.policy.transfers.perMonthRaw,
          requestId: args.requestId,
          idempotencyKey: `${input.idempotencyKey}:month`,
          policyVersionId: args.version.id,
        })
      : null;

  if (monthly !== null && monthly.status === 'LIMIT_EXCEEDED' && dailyHold !== null) {
    await release(tx, dailyHold, 'monthly window refused the hold');
    await appendEvent(tx, {
      orgId,
      actor: input.agentId,
      actorType: 'agent',
      eventType: 'policy.evaluated',
      resource: 'transaction_request',
      resourceId: args.requestId,
      policyVersionId: args.version.id,
      decision: 'DENY',
      reasonCodes: ['LIMIT_RESERVATION_FAILED'],
      severity: 'warning',
      metadata: {
        code: 'LIMIT_RESERVATION_FAILED',
        detail: `monthly: reserved ${monthly.reservedRaw} + ${monthly.requestedRaw} > ${monthly.maxRaw}`,
      },
    });
    await setRequestState(tx, { requestId: args.requestId, from: args.from, to: 'DENIED', actor: 'system' });
    return denied(['LIMIT_RESERVATION_FAILED'], args.requestId);
  }

  if (held.status === 'LIMIT_EXCEEDED') {
    // The engine said yes a moment ago and the ledger said no: that gap is the race
    // the reservation exists to close, and the audit line has to name the ledger as
    // the one that refused.
    await appendEvent(tx, {
      orgId,
      actor: input.agentId,
      actorType: 'agent',
      eventType: 'policy.evaluated',
      resource: 'transaction_request',
      resourceId: args.requestId,
      policyVersionId: args.version.id,
      decision: 'DENY',
      reasonCodes: ['LIMIT_RESERVATION_FAILED'],
      severity: 'warning',
      metadata: {
        code: 'LIMIT_RESERVATION_FAILED',
        detail: `reserved ${held.reservedRaw} + ${held.requestedRaw} > ${held.maxRaw}`,
      },
    });
    await setRequestState(tx, { requestId: args.requestId, from: args.from, to: 'DENIED', actor: 'system' });
    return denied(['LIMIT_RESERVATION_FAILED'], args.requestId);
  }

  await setRequestState(tx, { requestId: args.requestId, from: args.from, to: 'RESERVED', actor: 'system' });

  const allowed = await recordDecision(tx, {
    orgId,
    requestId: args.requestId,
    policyVersionId: args.version.id,
    outcome: 'ALLOW',
    digest: args.digest,
  });
  const ticket = await mintTicket(tx, {
    decisionId: allowed.id,
    digest: args.digest,
    walletId: input.candidate.walletId,
    expiresAtMs: deps.nowMs() + 60_000n,
  });

  const sealed = sealTicket(
    claimsFor({
      ticketId: ticket.id,
      requestId: args.requestId,
      agentId: input.agentId,
      walletId: input.candidate.walletId,
      policyVersionId: args.version.id,
      digest: args.digest,
      amountRaw: args.amountRaw,
      issuedAtMs: deps.nowMs(),
      authorityMode: args.policy.authorityMode,
      nonce: ticket.id,
    }),
    deps.ticketKey,
  );
  if (!sealed.ok) {
    // Throwing rolls the transaction back, which is the only acceptable outcome: a
    // reservation held and no ticket issued is exactly the self-inflicted lockout
    // T13 warns about, so the decision row, the reservation and the audit trail all
    // have to go together.
    throw new Error(`an authorised request failed to seal: ${sealed.reason}`);
  }

  await appendEvent(tx, {
    orgId,
    actor: input.agentId,
    actorType: 'agent',
    eventType: 'ticket.minted',
    resource: 'transaction_request',
    resourceId: args.requestId,
    policyVersionId: args.version.id,
    metadata: { digestRef: args.digest.slice(0, 24), keyId: allowed.id },
  });
  await setRequestState(tx, { requestId: args.requestId, from: 'RESERVED', to: 'TICKET_MINTED', actor: 'system' });

  return {
    status: 'TICKET_ISSUED',
    requestId: args.requestId,
    ticket: sealed.ticket,
    ticketId: ticket.id,
    digest: args.digest,
    canonical: args.canonical,
  };
}

/**
 * The answer a retry gets, reconstructed from what is already stored.
 *
 * Nothing is re-evaluated here: the policy that governed the first attempt may have
 * been superseded in the meantime, and re-deciding a request that already has an
 * answer is how a denial becomes a yes on the second try (§4's terminal states).
 */
async function replay(
  tx: TenantTx,
  orgId: string,
  input: AuthorizeInput,
  requestId: string,
  deps: PipelineDeps,
): Promise<AuthorizeOutcome> {
  const row = await tx.client.query<{
    lifecycle_state: string;
    digest: string;
    ticket_id: string;
    policy_version_id: string;
    approval_id: string;
    approval_expires_at: Date;
  }>(
    `SELECT r.lifecycle_state, r.digest, t.id AS ticket_id, r.agent_id,
            d.policy_version_id, a.id AS approval_id, a.expires_at AS approval_expires_at
       FROM ari.transaction_requests r
       LEFT JOIN ari.authorization_decisions d ON d.request_id = r.id
       LEFT JOIN ari.signing_tickets t ON t.decision_id = d.id
       LEFT JOIN ari.approval_requests a ON a.subject_id = r.id
      WHERE r.id = $1 AND r.org_id = $2`,
    [requestId, orgId],
  );
  const stored = row.rows[0];
  const state = stored?.lifecycle_state ?? 'DRAFT';

  if (state === 'TICKET_MINTED' && stored?.ticket_id !== undefined && stored.policy_version_id !== undefined) {
    const governing = await loadVersion(tx, stored.policy_version_id);
    if (governing === null) {
      // No fallback here. Guessing a mode would mint a replayable ticket whose
      // authority claim is whatever this function defaulted to.
      return { status: 'REFUSED', requestId, reason: 'the governing version is gone; the original ticket cannot be re-sealed' };
    }
    // Re-sealed rather than stored: the ticket is a capability and §11's rule says
    // capabilities are not persisted. Same id, same digest, same single-use row in
    // `signing_tickets`, so the second presentation of either string still spends
    // the one authorisation rather than getting a second one.
    const amount = await tx.client.query<{ amount_raw: string | null; canonical: string }>(
      `SELECT amount_raw, canonical FROM ari.transaction_requests WHERE id = $1`,
      [requestId],
    );
    const sealed = sealTicket(
      claimsFor({
        ticketId: stored.ticket_id,
        requestId,
        agentId: input.agentId,
        walletId: input.candidate.walletId,
        policyVersionId: stored.policy_version_id,
        digest: stored.digest as ReturnType<typeof computeDigest>,
        amountRaw: BigInt(amount.rows[0]?.amount_raw ?? '0'),
        issuedAtMs: deps.nowMs(),
        // Read from the version the original decision was made under, never from the
        // candidate that arrived on this retry: the retry's payload is untrusted
        // input, and the mode is part of what was authorised.
        authorityMode: governing.compiled.authorityMode,
        nonce: stored.ticket_id,
      }),
      deps.ticketKey,
    );
    if (sealed.ok) {
      return {
        status: 'TICKET_ISSUED',
        requestId,
        ticket: sealed.ticket,
        ticketId: stored.ticket_id,
        digest: stored.digest,
        canonical: amount.rows[0]?.canonical ?? '',
      };
    }
  }

  if (state === 'APPROVAL_PENDING' && stored?.approval_id !== undefined && stored.approval_expires_at !== undefined) {
    return {
      status: 'AWAITING_APPROVAL',
      requestId,
      approvalId: stored.approval_id,
      expiresAt: stored.approval_expires_at.toISOString(),
    };
  }

  if (state === 'DENIED') {
    return denied(['IDEMPOTENCY_CONFLICT'], requestId);
  }

  return {
    status: 'REFUSED',
    requestId,
    reason: `request is already in ${state}; a retry gets the original answer, not a new attempt`,
  };
}

/**
 * What the delivery step did, after the decision transaction committed.
 *
 * A second transaction, because the signing attempt is an outside event: the money is
 * committed in the first one (hold, decision, ticket, audit) and the signer's answer
 * arrives after it. Collapsing the two would mean holding a tenant's advisory lock and
 * an open transaction across a network call to another process, and a slow signer would
 * then serialize *requests* behind a *signature*.
 *
 * Three answers, and only one of them is final:
 * - `COMPLETE` settles the holds. This is "the authority plane says it signed", which
 *   for the mock provider is not chain truth (S12) — but it is the point at which the
 *   cap must stop counting the money as parked, and reconciliation owns whatever comes
 *   after.
 * - A state still in flight (`SIGNING_PENDING`, `PENDING`, and every `user_gated`
 *   handoff) leaves the holds exactly as they are. Nothing has been signed yet, and
 *   settling on an intention would be the same overclaim in the other direction.
 * - A terminal refusal (`TICKET_ALREADY_USED`, a digest or key mismatch) releases them,
 *   because no later attempt can honour this request either, and a refusal that eats
 *   the agent's daily capacity is T13 with our own hand on the lever.
 *
 * A transient failure (`SIGNING_PROVIDER_ERROR`, nothing answering at all) also leaves
 * the holds: the retry path re-seals the same ticket and re-delivers it, and releasing
 * on a network hiccup would let an agent spend twice on the day the signer blipped.
 */
export async function recordDeliveryOutcome(
  deps: PipelineDeps,
  orgId: string,
  requestId: string,
  delivered: { readonly accepted: boolean; readonly state?: string; readonly code?: string },
): Promise<'SETTLED' | 'RELEASED' | 'HELD'> {
  const terminal =
    !delivered.accepted &&
    delivered.code !== undefined &&
    TERMINAL_REFUSALS.has(delivered.code);

  if (delivered.accepted && delivered.state !== 'COMPLETE') return 'HELD';
  if (!delivered.accepted && !terminal) return 'HELD';

  return asTenant(deps.pool, orgId, async (tx) => {
    if (delivered.accepted) {
      const settled = await settleForRequest(tx, requestId);
      await appendEvent(tx, {
        orgId,
        actor: 'system',
        actorType: 'system',
        eventType: 'reservation.settled',
        resource: 'transaction_request',
        resourceId: requestId,
        metadata: { amountRaw: settled.settledRaw.toString(), provider: delivered.state ?? 'COMPLETE' },
      });
      // Walked, not teleported: `TICKET_MINTED → SIGNING_COMPLETE` is not an edge in the
      // state machine, and the missing stop is the honest one — the handoff to the
      // authority plane happened, and then it completed.
      await advance(tx, requestId, 'SIGNING_PENDING');
      await advance(tx, requestId, 'SIGNING_COMPLETE');
      return 'SETTLED';
    }
    const released = await releaseForRequest(tx, requestId, `signer refused: ${delivered.code ?? 'unknown'}`);
    await appendEvent(tx, {
      orgId,
      actor: 'system',
      actorType: 'system',
      eventType: 'reservation.released',
      resource: 'transaction_request',
      resourceId: requestId,
      severity: 'warning',
      reasonCodes: [delivered.code ?? 'TICKET_INVALID'],
      metadata: { amountRaw: released.releasedRaw.toString(), code: delivered.code ?? 'TICKET_INVALID' },
    });
    await advance(tx, requestId, 'SIGNING_PENDING');
    await advance(tx, requestId, 'SIGNING_FAILED');
    return 'RELEASED';
  });
}

/**
 * Move a request one step along its lifecycle if — and only if — that step exists.
 *
 * `setRequestState` is a compare-and-set and refuses anything else, which is right for
 * the decision path and wrong here: this runs after the fact, on a request another
 * attempt may already have advanced, and a duplicate delivery answer must not turn into
 * a 500 over a state that is already where it belongs.
 */
async function advance(tx: TenantTx, requestId: string, to: LifecycleState): Promise<void> {
  const current = await requestStateOf(tx, requestId);
  if (current === null) return;
  const from = LifecycleState.safeParse(current.lifecycleState);
  // A state this build does not recognise is not something to walk on from: it came
  // from a later migration or a different deployment, and the honest answer is to leave
  // the row where it is rather than guess the next edge.
  if (!from.success || !canTransition(from.data, to)) return;
  await setRequestState(tx, { requestId, from: from.data, to, actor: 'system' });
}

/** Refusals that no retry can turn into a signature. */
const TERMINAL_REFUSALS = new Set(['TICKET_ALREADY_USED', 'TICKET_DIGEST_MISMATCH', 'SIGNER_KEY_MISMATCH', 'TICKET_INVALID']);

export async function authorize(
  deps: PipelineDeps,
  orgId: string,
  input: AuthorizeInput,
): Promise<AuthorizeOutcome> {
  return asTenant(deps.pool, orgId, (tx) => within(deps, tx, orgId, input));
}

/** The other half of the boundary, for the composition root and the tests that walk it. */
export { claimTicket };
