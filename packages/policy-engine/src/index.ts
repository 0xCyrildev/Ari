/**
 * The policy engine — Ari's security kernel.
 *
 * Four properties, each of which is the subject of a test:
 *
 *   1. **Pure.** No I/O, no clock, no randomness, no model. `now` arrives in the
 *      state, so the same inputs always produce the same bytes of decision. That
 *      is what lets a decision made in March be re-derived in September, which is
 *      the difference between an audit trail and a story.
 *   2. **Total.** Every branch returns one of three outcomes. There is no path
 *      through this file that returns nothing, throws to a caller, or yields
 *      "unspecified" (invariants S1, S15).
 *   3. **Deterministic on ordering.** Rules are evaluated in a fixed order and
 *      every refusal carries the codes that caused it, so a DENY is explainable
 *      to the agent, the operator and the auditor.
 *   4. **Oblivious to the model.** This module does not import the intent engine
 *      or the risk engine — see the import list. The architecture's central
 *      claim is a fact about this file's dependency graph (ARCHITECTURE §12).
 */

import {
  type CandidateTransaction,
  type CanonicalDigest,
  type EscalationCondition,
  type Decision,
  type PolicyDocument,
  type ReasonCode,
  type RiskAssessment,
  type MatchedRule,
} from '@ari/schemas';
import { computeDigest } from '@ari/transaction-engine';

// ---------------------------------------------------------------------------
// Compiled form
// ---------------------------------------------------------------------------

export interface CompiledPolicy {
  readonly policyId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly name: string;
  readonly walletId: string;
  readonly authorityMode: 'delegated' | 'user_gated';
  readonly transfers: {
    readonly enabled: boolean;
    readonly chains: ReadonlySet<string>;
    /** Asset identity key: `native:ethereum` or `erc20:ethereum:<contract>`. */
    readonly assets: ReadonlySet<string>;
    readonly recipients: ReadonlySet<string>;
    readonly perTransactionRaw: bigint;
    readonly perDayRaw: bigint;
    readonly perMonthRaw: bigint | null;
    readonly amountUnit: string;
    readonly maxTransactionsPerHour: number;
  };
  readonly contractCalls: { readonly enabled: boolean; readonly contracts: ReadonlySet<string> };
  readonly newRecipients: { readonly allowed: boolean; readonly requireApproval: boolean };
  readonly escalation: readonly PolicyDocument['escalation']['humanApproval']['requiredWhen'][number][];
  /**
   * How a `REQUIRE_HUMAN_APPROVAL` is satisfied: who may decide, and how many of
   * them. Kept on the compiled form because the pipeline reads this without ever
   * touching the authoring document — that separation is A4, and an approval flow
   * that reached back into the draft shape would quietly end it.
   */
  readonly approval: {
    readonly quorum: number;
    readonly approverRoles: readonly string[];
  };
  readonly validity: {
    readonly ttlSeconds: number;
    readonly notBeforeMs: bigint | null;
    readonly notAfterMs: bigint | null;
    readonly maxIkaRawPerDay: bigint;
    readonly alertAtIkaRawPerDay: bigint;
  };
  readonly fallback: PolicyDocument['fallback'];
  readonly limits: PolicyDocument['limits'];
}

export class PolicyCompilationError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'PolicyCompilationError';
  }
}

function assetKey(asset: { kind: string; chain: string; contract?: string }): string {
  return asset.kind === 'native' ? `native:${asset.chain}` : `erc20:${asset.chain}:${asset.contract}`;
}

function isoToMs(value: string | null): bigint | null {
  return value === null ? null : BigInt(Date.parse(value));
}

/**
 * Compilation is where unit mismatches become fatal rather than silent.
 * `perTransaction.unit !== perDay.unit` would otherwise let an amount pass a
 * daily limit interpreted in one unit and a per-transaction limit in another.
 */
export function compilePolicy(document: PolicyDocument, ids: {
  policyId: string;
  versionId: string;
  versionNumber: number;
}): CompiledPolicy {
  const t = document.permissions.transfers;
  if (t.perTransaction.unit !== t.perDay.unit) {
    throw new PolicyCompilationError(
      'per-transaction and per-day limits must share a unit',
      'permissions.transfers.perDay.unit',
    );
  }
  if (t.perMonth !== null && t.perMonth.unit !== t.perTransaction.unit) {
    throw new PolicyCompilationError('per-month limit unit mismatch', 'permissions.transfers.perMonth.unit');
  }
  if (t.enabled && t.chains.length === 0) {
    throw new PolicyCompilationError(
      'transfers are enabled with no permitted chains — this is a deny, not a policy',
      'permissions.transfers.chains',
    );
  }

  return {
    policyId: ids.policyId,
    versionId: ids.versionId,
    versionNumber: ids.versionNumber,
    name: document.meta.name,
    walletId: document.target.walletId,
    authorityMode: document.target.authorityMode,
    transfers: {
      enabled: t.enabled,
      chains: new Set(t.chains),
      assets: new Set(t.assets.map((asset) => assetKey(asset))),
      recipients: new Set(t.recipients.addresses),
      perTransactionRaw: BigInt(t.perTransaction.maxRaw),
      perDayRaw: BigInt(t.perDay.maxRaw),
      perMonthRaw: t.perMonth === null ? null : BigInt(t.perMonth.maxRaw),
      amountUnit: t.perTransaction.unit,
      maxTransactionsPerHour: t.maxTransactionsPerHour,
    },
    contractCalls: {
      enabled: document.permissions.contractCalls.enabled,
      contracts: new Set(document.permissions.contractCalls.contracts),
    },
    newRecipients: document.permissions.newRecipients,
    escalation: document.escalation.humanApproval.requiredWhen,
    approval: {
      quorum: document.escalation.humanApproval.quorum,
      approverRoles: document.escalation.humanApproval.approverRoles,
    },
    validity: {
      ttlSeconds: document.validity.transactionTtlSeconds,
      notBeforeMs: isoToMs(document.validity.notBefore),
      notAfterMs: isoToMs(document.validity.notAfter),
      maxIkaRawPerDay: BigInt(document.validity.signingBudget.maxIkaRawPerDay),
      alertAtIkaRawPerDay: BigInt(document.validity.signingBudget.alertAtIkaRawPerDay),
    },
    fallback: document.fallback,
    limits: document.limits,
  };
}

// ---------------------------------------------------------------------------
// Evaluation input
// ---------------------------------------------------------------------------

export interface EvaluationState {
  /** Supplied, never read from a clock — a pure function must be replayable. */
  readonly nowMs: bigint;
  readonly requestId: string;
  readonly agentId: string;
  readonly agentStatus: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  readonly scopes: readonly string[];
  readonly usage: {
    readonly reservedDayRaw: bigint;
    readonly reservedMonthRaw: bigint;
    readonly transactionsLastHour: number;
    readonly ikaSpentTodayRaw: bigint;
  };
  readonly history: {
    readonly baselineAssets: ReadonlySet<string>;
    readonly baselineChains: ReadonlySet<string>;
    /**
     * When the *candidate's* recipient was first settled, or null for one never seen.
     * Resolved by the caller, because the kernel reads no storage: this is one indexed
     * probe for the one address a rule can ask about, not a profile of everything the
     * wallet has ever paid.
     */
    readonly recipientFirstSeenAtMs: bigint | null;
  };
  readonly risk: RiskAssessment | null;
  readonly simulation: {
    readonly available: boolean;
    readonly success: boolean;
    readonly mismatch: boolean;
    readonly warningCount: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * The engine. Note what is *absent*: any await, any import of an AI module, any
 * `Date.now()`, and any branch that does not end in a decision.
 */
export function evaluate(input: {
  policy: CompiledPolicy;
  candidate: CandidateTransaction;
  state: EvaluationState;
}): Decision {
  const { policy, candidate, state } = input;
  const matched: MatchedRule[] = [];

  /**
   * Derived here rather than accepted from the caller.
   *
   * The previous contract took `state.digest` as an input, which meant the
   * composition root could hand `evaluate()` a candidate and a digest computed
   * over some *other* candidate: the engine would then ALLOW on the bytes it was
   * shown, the ticket would seal the digest it was handed, and the two would
   * disagree — an authorization for one transaction spent on another (T10, T25).
   * Binding is now something the kernel does, not something it is told.
   */
  let sealed: CanonicalDigest | null = null;
  const digestOf = (): CanonicalDigest =>
    (sealed ??= computeDigest(candidate, { policyVersionId: policy.versionId }));

  const base = {
    requestId: state.requestId,
    policyId: policy.policyId,
    policyVersionId: policy.versionId,
    evaluatedAtMs: state.nowMs,
    matchedRules: matched,
    riskLevel: state.risk === null ? null : state.risk.level,
  } as const;

  const deny = (codes: ReasonCode[], rulePath: string, detail?: string): Decision => ({
    ...base,
    outcome: 'DENY',
    reasonCodes: codes,
    matchedRules: [
      ...matched,
      { rulePath, outcome: 'deny', detail: detail ?? null },
    ],
  });

  const escalate = (codes: ReasonCode[], rulePath: string, detail?: string): Decision => ({
    ...base,
    outcome: 'REQUIRE_HUMAN_APPROVAL',
    reasonCodes: codes,
    digest: digestOf(),
    expiresAt: new Date(
      Number(state.nowMs + BigInt(policy.validity.ttlSeconds * 1000)),
    ).toISOString(),
    matchedRules: [
      ...matched,
      { rulePath, outcome: 'escalate', detail: detail ?? null },
    ],
  });

  const note = (rulePath: string): void => {
    matched.push({ rulePath, outcome: 'allow', detail: null });
  };

  try {
    // --- 1. identity ---------------------------------------------------------
    if (state.agentStatus === 'REVOKED') return deny(['AGENT_REVOKED'], 'identity.agentStatus');
    if (state.agentStatus === 'PAUSED') return deny(['AGENT_PAUSED'], 'identity.agentStatus');
    if (!state.scopes.includes('transaction:request')) {
      return deny(['SCOPE_MISSING'], 'identity.scopes', 'transaction:request');
    }

    // --- 2. unsupported / unknown (before any limit arithmetic) --------------
    if (candidate.kind === 'unknown') {
      return deny(['TRANSACTION_UNKNOWN'], 'permissions.unknown', candidate.reason);
    }
    if (candidate.kind === 'contract_call' && !policy.contractCalls.enabled) {
      return deny(['CONTRACTS_NOT_ALLOWED'], 'permissions.contractCalls.enabled');
    }
    if (candidate.kind === 'contract_call' && !policy.contractCalls.contracts.has(candidate.contract)) {
      return deny(['CONTRACT_NOT_ALLOWED'], 'permissions.contractCalls.contracts', candidate.contract);
    }
    if (candidate.kind === 'transfer' && !policy.transfers.enabled) {
      return deny(['TRANSFER_TYPE_DISABLED'], 'permissions.transfers.enabled');
    }

    // --- 3. policy validity window ------------------------------------------
    if (policy.validity.notBeforeMs !== null && state.nowMs < policy.validity.notBeforeMs) {
      return deny(['POLICY_NOT_YET_VALID'], 'validity.notBefore');
    }
    if (policy.validity.notAfterMs !== null && state.nowMs > policy.validity.notAfterMs) {
      return deny(['POLICY_EXPIRED'], 'validity.notAfter');
    }
    // Parsed as a number first, because `BigInt(NaN)` throws before any check
    // could run: written the other way round, the refusal below was unreachable
    // and an unparseable deadline escaped the engine as an exception rather than
    // arriving as a DENY.
    const deadlineMs = Date.parse(candidate.deadline);
    if (!Number.isFinite(deadlineMs)) {
      return deny(['INTERNAL_ERROR_FAIL_CLOSED'], 'candidate.deadline');
    }
    if (BigInt(deadlineMs) <= state.nowMs) return deny(['DEADLINE_EXPIRED'], 'candidate.deadline');
    note('validity.window');

    // --- 4. scope of permission ---------------------------------------------
    if (candidate.kind === 'transfer') {
      if (!policy.transfers.chains.has(candidate.chain)) {
        return deny(['CHAIN_NOT_SUPPORTED'], 'permissions.transfers.chains', candidate.chain);
      }
      const key = assetKey(candidate.asset);
      if (!policy.transfers.assets.has(key)) {
        return deny(['ASSET_NOT_ALLOWED'], 'permissions.transfers.assets', key);
      }
      const recipient = candidate.recipient.address;
      if (!policy.transfers.recipients.has(recipient)) {
        if (!policy.newRecipients.allowed && !policy.newRecipients.requireApproval) {
          return deny(['RECIPIENT_NOT_IN_ALLOWLIST'], 'permissions.transfers.recipients', recipient);
        }
        if (!policy.newRecipients.allowed && policy.newRecipients.requireApproval) {
          return escalate(
            ['RECIPIENT_NOT_ALLOWED', 'NEW_RECIPIENT_NOT_ALLOWED'],
            'permissions.newRecipients',
            recipient,
          );
        }
      } else {
        note('permissions.transfers.recipients');
      }
    }

    // --- 5. monetary limits --------------------------------------------------
    if (candidate.kind === 'transfer') {
      if (candidate.amount.unit !== policy.transfers.amountUnit) {
        return deny(
          ['INTERNAL_ERROR_FAIL_CLOSED'],
          'permissions.transfers.perTransaction.unit',
          `amount unit ${candidate.amount.unit} != policy unit ${policy.transfers.amountUnit}`,
        );
      }
      const amount = candidate.amount.raw;
      // A zero-amount transfer is refused, but not with the code that means
      // "too big": an audit reader chasing an over-cap payment would be sent to
      // the wrong rule, and the agent gets told the wrong thing about its own
      // request.
      if (amount <= 0n) return deny(['AMOUNT_ZERO'], 'amount.positive');
      if (amount > policy.transfers.perTransactionRaw) {
        return deny(
          ['AMOUNT_EXCEEDS_PER_TRANSACTION'],
          'permissions.transfers.perTransaction',
          `${amount} > ${policy.transfers.perTransactionRaw}`,
        );
      }
      if (state.usage.reservedDayRaw + amount > policy.transfers.perDayRaw) {
        return deny(
          ['AMOUNT_EXCEEDS_DAILY_LIMIT', 'LIMIT_RESERVATION_FAILED'],
          'permissions.transfers.perDay',
          `${state.usage.reservedDayRaw + amount} > ${policy.transfers.perDayRaw}`,
        );
      }
      if (
        policy.transfers.perMonthRaw !== null &&
        state.usage.reservedMonthRaw + amount > policy.transfers.perMonthRaw
      ) {
        return deny(['AMOUNT_EXCEEDS_MONTHLY_LIMIT'], 'permissions.transfers.perMonth');
      }
      note('permissions.transfers.limits');
    }

    if (state.usage.transactionsLastHour + 1 > policy.transfers.maxTransactionsPerHour) {
      return deny(['VELOCITY_EXCEEDS_HOURLY_LIMIT'], 'permissions.transfers.maxTransactionsPerHour');
    }

    // --- 6. cost guard (ASSUMPTIONS §4.3) ------------------------------------
    // Denied *before* the expensive call: a per-operation protocol fee means a
    // policy bug is a money bug even when it never produces a signature.
    if (state.usage.ikaSpentTodayRaw >= policy.validity.maxIkaRawPerDay) {
      return deny(['SIGNING_BUDGET_EXCEEDED'], 'validity.signingBudget.maxIkaRawPerDay');
    }

    // --- 7. risk: may escalate, may never grant ------------------------------
    // Both arms of the fallback are decisions, and neither is "carry on as though an
    // assessment had arrived". Before this, a `null` risk with `onRiskUnavailable:
    // 'escalate'` fell straight through stage 7 unless the policy also happened to
    // write a `risk_gte` condition — so the fallback a human chose for the case where
    // the risk engine is down was silently permissive for every policy that did not.
    if (state.risk === null) {
      if (policy.fallback.onRiskUnavailable === 'deny') {
        return deny(['RISK_ENGINE_UNAVAILABLE'], 'fallback.onRiskUnavailable');
      }
      return escalate(
        ['RISK_ENGINE_UNAVAILABLE'],
        'fallback.onRiskUnavailable',
        'no assessment was available, and this policy sends that to a human',
      );
    }
    if (state.simulation !== null && state.simulation.mismatch) {
      return deny(['SIMULATION_MISMATCH'], 'simulation.mismatch');
    }
    if (
      state.simulation !== null &&
      !state.simulation.available &&
      policy.fallback.onSimulationUnavailable === 'deny'
    ) {
      return deny(['SIMULATION_UNAVAILABLE'], 'fallback.onSimulationUnavailable');
    }
    if (state.simulation !== null && !state.simulation.success) {
      return deny(['SIMULATION_FAILED'], 'simulation.success');
    }

    // --- 8. explicit escalation conditions -----------------------------------
    for (const condition of policy.escalation) {
      const hit = matchesCondition(condition, { policy, candidate, state });
      if (hit === 'error') {
        return deny(['INTERNAL_ERROR_FAIL_CLOSED'], 'escalation.condition', condition.op);
      }
      if (hit) {
        return escalate(
          ['HUMAN_APPROVAL_REQUIRED', escalationCodeFor(condition)],
          `escalation.humanApproval.requiredWhen[${condition.op}]`,
        );
      }
    }

    // --- 9. allow ------------------------------------------------------------
    const codes: ReasonCode[] = [];
    if (state.usage.ikaSpentTodayRaw >= policy.validity.alertAtIkaRawPerDay) {
      // Not a denial: an allowance that carries its own warning, so the audit
      // record of a later budget incident shows it was visible before it happened.
      codes.push('SIGNING_BUDGET_EXCEEDED');
    }
    return {
      ...base,
      outcome: 'ALLOW',
      reasonCodes: codes,
      digest: digestOf(),
      authorityMode: policy.authorityMode,
      matchedRules: [...matched, { rulePath: 'decision', outcome: 'allow', detail: null }],
    };
  } catch (error) {
    // Fail-closed, and *loudly*: the error is converted into a denial that names
    // itself, rather than propagating to a caller that might treat a caught
    // exception as "no decision was made" (assumption A11, invariant S15).
    const message = error instanceof Error ? error.message : 'non-error thrown';
    return deny(['INTERNAL_ERROR_FAIL_CLOSED'], 'engine.exception', message);
  }
}

/**
 * The reason code that names an escalation, for each condition that can ask for
 * one. The parameter is the real union and the tail is an exhaustiveness check, so
 * adding a condition to the authoring schema without a code here is a compile
 * error rather than a `default` that quietly reports something misleading.
 */
function escalationCodeFor(condition: EscalationCondition): ReasonCode {
  switch (condition.op) {
    case 'amount_gt':
      return 'HUMAN_APPROVAL_REQUIRED';
    case 'recipient_not_in_allowlist':
      return 'RECIPIENT_NOT_ALLOWED';
    case 'recipient_first_seen_within_days':
      return 'NEW_RECIPIENT_NOT_ALLOWED';
    case 'asset_not_in_baseline':
      return 'ASSET_NOVEL';
    case 'chain_not_in_baseline':
      return 'CHAIN_NOVEL';
    case 'risk_gte':
      return 'RISK_ESCALATION_REQUIRED';
    case 'usd_gte':
      return 'HUMAN_APPROVAL_REQUIRED';
    case 'velocity_gt_per_hour':
      return 'HUMAN_APPROVAL_REQUIRED';
    case 'time_out_of_hours_window':
      return 'OUT_OF_HOURS_WINDOW';
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/**
 * Condition evaluation. Returns `'error'` for anything it cannot interpret —
 * an unparseable time window escalates rather than silently skipping the rule,
 * because a broken guard that reports "not triggered" is worse than no guard.
 */
/**
 * What stage 8 may be asked about.
 *
 * `unknown` is absent because stage 2 has already refused it, and saying so in the
 * type is what lets the chain and asset rules read `candidate.chain` without a
 * branch that can never be taken — a guard that looks defensive and is actually
 * unreachable is how a dead arm gets mistaken for coverage.
 */
type EvaluableCandidate = Exclude<CandidateTransaction, { kind: 'unknown' }>;

function matchesCondition(
  condition: PolicyDocument['escalation']['humanApproval']['requiredWhen'][number],
  ctx: {
    policy: CompiledPolicy;
    candidate: EvaluableCandidate;
    state: EvaluationState;
  },
): boolean | 'error' {
  const { candidate, state, policy } = ctx;

  switch (condition.op) {
    case 'amount_gt': {
      if (candidate.kind !== 'transfer') return false;
      if (condition.unit !== policy.transfers.amountUnit) return 'error';
      return candidate.amount.raw > BigInt(condition.raw);
    }
    case 'usd_gte': {
      if (candidate.usdEstimate === null) {
        // Missing evidence is not good evidence: a required escalation cannot be
        // skipped because the FX estimate is absent. This used to read
        // `state.risk === null ? 'error' : true`, which reached for the risk engine's
        // absence as a reason to fail closed — a case stage 7 now answers before
        // control can ever get here, for either value of the fallback. A condition
        // arm that cannot be reached is an arm that cannot be tested, so it is gone
        // rather than kept and commented.
        return true;
      }
      const ageSeconds = (state.nowMs - BigInt(Date.parse(candidate.usdEstimate.asOf))) / 1000n;
      // A future-stamped estimate is as unusable as a stale one, and either one
      // escalates rather than letting an unverifiable figure clear a threshold.
      if (ageSeconds < 0n || ageSeconds > BigInt(policy.limits.maxUsdEstimateAgeSeconds)) return true;
      return candidate.usdEstimate.cents >= BigInt(condition.cents);
    }
    case 'recipient_not_in_allowlist': {
      if (candidate.kind !== 'transfer') return false;
      return !policy.transfers.recipients.has(candidate.recipient.address);
    }
    case 'recipient_first_seen_within_days': {
      if (candidate.kind !== 'transfer') return false;
      const firstSeen = state.history.recipientFirstSeenAtMs;
      // Never settled is never "seen recently": the novelty an unknown recipient carries
      // is `newRecipients`' business, and this rule asks about a *recent first payment*.
      if (firstSeen === null) return false;
      return state.nowMs - firstSeen <= BigInt(condition.days) * 86_400_000n;
    }
    case 'asset_not_in_baseline': {
      if (candidate.kind !== 'transfer') return false;
      return !state.history.baselineAssets.has(assetKey(candidate.asset));
    }
    case 'chain_not_in_baseline':
      return !state.history.baselineChains.has(candidate.chain);
    case 'risk_gte': {
      // An unavailable risk engine is already a DENY by the time stage 8 runs if
      // the policy says so, so the only way here is a policy that chose to
      // escalate: treat the missing assessment as the escalation it asked for.
      if (state.risk === null) return true;
      const order = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
      return order.indexOf(state.risk.level) >= order.indexOf(condition.level);
    }
    case 'velocity_gt_per_hour':
      return state.usage.transactionsLastHour > condition.count;
    case 'time_out_of_hours_window': {
      const parsed = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(condition.window);
      if (parsed === null) return 'error';
      const hours = new Date(Number(state.nowMs)).getUTCHours();
      const start = Number(parsed[1]);
      const end = Number(parsed[3]);
      return start <= end
        ? !(hours >= start && hours < end)
        : !(hours >= start || hours < end);
    }
    default: {
      const exhaustive: never = condition;
      void exhaustive;
      return 'error';
    }
  }
}
