/**
 * Human approval — the third outcome the policy engine can return, and the one
 * that completes the decision set (§8, Phase 6).
 *
 * Three properties, each of which is a specific attack rather than a general
 * hygiene item:
 *
 *   - **Bound.** The token commits to the digest, the amount, the wallet, the
 *     agent, the policy version and an expiry. Approving one transaction cannot
 *     authorise another, because the claim is checked against the bytes the human
 *     was shown at the moment of redemption (T12).
 *   - **One-time.** Consumption is an atomic claim on a row, not a flag on a
 *     string, and the second attempt is an *event* — `approval_reuse_attempted` is
 *     how an operator learns that something was replayed rather than that a request
 *     failed twice.
 *   - **Counted where the count is true.** Quorum is tallied under a row lock and
 *     the `GRANTED` transition is refused by a trigger unless the votes are actually
 *     there. A status column that says GRANTED without votes behind it is a quorum
 *     that exists only in the database's own imagination.
 *
 * Note what no function here returns: an `AuthorizationTicket`. Approving is not
 * signing, and the gap between those two is the whole architecture (§1).
 */

import { appendEvent } from '@ari/audit';
import { asTenant, type Connector, type TenantTx } from '@ari/identity';
import { newId, type CanonicalDigest, type ReasonCode } from '@ari/schemas';
import { randomBytes } from 'node:crypto';
import { ApprovalKey, openApproval, sealApproval, type ApprovalClaims } from './token.js';

export type ApprovalSubject = 'transaction' | 'policy_activation';
export type ApprovalStatus = 'PENDING' | 'GRANTED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED';

export interface RequestApprovalInput {
  readonly subjectKind: ApprovalSubject;
  readonly subjectId: string;
  readonly requestId: string;
  readonly digest: CanonicalDigest;
  readonly policyVersionId: string;
  readonly agentId: string;
  readonly walletId: string;
  /** Null when the thing being approved moves no token amount — a valueless contract call. */
  readonly amountRaw: bigint | null;
  readonly currencyUnit: string;
  readonly quorumNeeded: number;
  readonly allowedRoles: readonly string[];
  readonly requestedBy: string;
  readonly ttlMs: bigint;
  /**
   * Passed in, not read off the transaction handle. A sealing key is a secret and
   * the composition root is the only place that knows where it came from; putting
   * it on `TenantTx` would put it in scope for every query in the transaction.
   */
  readonly key: ApprovalKey;
}

export interface RequestedApproval {
  readonly approvalId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly quorumNeeded: number;
}

/**
 * Open an approval and hand back the token.
 *
 * The token is returned and not stored. It is a bearer capability bound to a
 * digest — persisting it would put the thing that authorises a payment into the
 * same table as the record of who approved it, and §11's redaction rule exists to
 * keep those two apart.
 */
export async function requestApproval(tx: TenantTx, input: RequestApprovalInput): Promise<RequestedApproval> {
  if (input.quorumNeeded < 1) throw new RangeError('an approval with no quorum is a no-op');
  if (input.ttlMs <= 0n) throw new RangeError('approvals expire; pass a positive ttl');

  const approvalId = newId('apr');
  const expiresAtMs = tx.startedAtMs + input.ttlMs;
  const expiresAt = new Date(Number(expiresAtMs)).toISOString();
  const claims: ApprovalClaims = {
    approvalId,
    requestId: input.requestId,
    digest: input.digest,
    policyVersionId: input.policyVersionId,
    agentId: input.agentId,
    walletId: input.walletId,
    // The seal always binds a number; the *row* keeps the difference between "no amount
    // is involved" (NULL) and "the amount is zero", which is the distinction a caller
    // cannot forge. Changing this to nullable would change every outstanding token's
    // payload bytes, and the payload is what the HMAC covers.
    amountRaw: input.amountRaw ?? 0n,
    currencyUnit: input.currencyUnit,
    expiresAtMs,
    nonce: newId('req'),
  };

  await tx.client.query(
    `INSERT INTO ari.approval_requests
       (id, org_id, subject_kind, subject_id, request_id, digest, policy_version_id, agent_id, wallet_id,
        amount_raw, currency_unit, quorum_needed, allowed_roles, requested_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      approvalId,
      tx.orgId,
      input.subjectKind,
      input.subjectId,
      input.requestId,
      input.digest,
      input.policyVersionId,
      input.agentId,
      input.walletId,
      input.amountRaw === null ? null : input.amountRaw.toString(),
      input.currencyUnit,
      input.quorumNeeded,
      [...input.allowedRoles],
      input.requestedBy,
      expiresAt,
    ],
  );
  await appendEvent(tx, {
    orgId: tx.orgId,
    actor: input.requestedBy,
    actorType: 'system',
    eventType: 'approval.requested',
    resource: 'approval_request',
    resourceId: approvalId,
    policyVersionId: input.policyVersionId,
    metadata: {
      ...(input.amountRaw === null ? {} : { amountRaw: input.amountRaw.toString() }),
      assetUnit: input.currencyUnit,
    },
  });

  return {
    approvalId,
    // Sealed here and never stored: the token is the capability, and the row is the
    // evidence. Keeping both in the database would mean a read of the approvals
    // table hands out authority rather than describing it.
    token: sealApproval(claims, input.key),
    expiresAt,
    quorumNeeded: input.quorumNeeded,
  };
}

export interface DecisionInput {
  readonly approvalId: string;
  readonly approver: string;
  readonly decision: 'APPROVED' | 'REJECTED';
}

export type DecisionResult =
  | { readonly ok: true; readonly status: ApprovalStatus; readonly votes: number }
  | { readonly ok: false; readonly code: ReasonCode; readonly detail: string };

/**
 * Record one human's decision.
 *
 * The row is locked before the vote is counted, so two approvers clicking at the
 * same instant cannot both be the one that reaches quorum — and the unique vote
 * constraint is what stops the same person being two of the three.
 */
export async function recordDecision(tx: TenantTx, input: DecisionInput): Promise<DecisionResult> {
  const locked = await tx.client.query<{
    status: ApprovalStatus;
    expires_at: Date;
    expired: boolean;
    allowed_roles: string[];
    requested_by: string;
    subject_kind: ApprovalSubject;
    quorum_needed: number;
    digest: string;
  }>(
    `SELECT status, expires_at, allowed_roles, requested_by, subject_kind, quorum_needed, digest,
            expires_at <= now() AS expired
       FROM ari.approval_requests WHERE id = $1 FOR UPDATE`,
    [input.approvalId],
  );
  const request = locked.rows[0];
  if (request === undefined) return { ok: false, code: 'APPROVAL_NOT_FOUND', detail: 'no such approval' };

  if (request.status !== 'PENDING') {
    return { ok: false, code: 'APPROVAL_ALREADY_CONSUMED', detail: `approval is ${request.status}` };
  }
  // `now()`, not the process clock: `expires_at` was stamped by the database from a
  // request whose TTL it read, and comparing it to a second clock in a second machine is
  // the same split that used to make revocations undateable. An approver's decision
  // arriving one second late should be refused by the row's own expiry, not by however
  // far this API host happens to have drifted.
  if (request.expired) {
    await tx.client.query(`UPDATE ari.approval_requests SET status = 'EXPIRED' WHERE id = $1`, [input.approvalId]);
    await appendEvent(tx, refusalEvent(tx, input.approvalId, 'approval.claim_refused', 'APPROVAL_EXPIRED', 'the window closed before the decision'));
    return { ok: false, code: 'APPROVAL_EXPIRED', detail: 'expired' };
  }

  const role = await roleOf(tx, input.approver);
  if (role === null || !request.allowed_roles.includes(role)) {
    await appendEvent(tx, refusalEvent(tx, input.approvalId, 'approval.claim_refused', 'APPROVER_NOT_AUTHORISED', `role ${role ?? 'none'} is not an approver here`));
    return { ok: false, code: 'APPROVER_NOT_AUTHORISED', detail: `role ${role ?? 'none'}` };
  }
  // T19, and the reason this is a refusal rather than a warning: the person who
  // moved an authority boundary is not the person who can sign it off, so a
  // malicious administrator cannot complete their own widening.
  if (request.subject_kind === 'policy_activation' && input.approver === request.requested_by) {
    await appendEvent(tx, refusalEvent(tx, input.approvalId, 'approval.claim_refused', 'APPROVER_NOT_AUTHORISED', 'the proposer cannot approve their own change'));
    return { ok: false, code: 'APPROVER_NOT_AUTHORISED', detail: 'self-approval' };
  }

  const voted = await tx.client.query(
    `INSERT INTO ari.approvals (id, approval_request_id, org_id, approver_user_id, role, decision, digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (approval_request_id, approver_user_id) DO NOTHING
     RETURNING id`,
    [newId('apr'), input.approvalId, tx.orgId, input.approver, role, input.decision, request.digest],
  );
  if ((voted.rowCount ?? 0) === 0) {
    return { ok: false, code: 'APPROVAL_ALREADY_CONSUMED', detail: 'this approver has already decided' };
  }

  await appendEvent(tx, {
    orgId: tx.orgId,
    actor: input.approver,
    actorType: 'human',
    eventType: input.decision === 'APPROVED' ? 'approval.granted' : 'approval.rejected',
    resource: 'approval_request',
    resourceId: input.approvalId,
    severity: input.decision === 'APPROVED' ? 'notice' : 'warning',
    metadata: { approverCount: String(quorumOf(request)) },
  });

  if (input.decision === 'REJECTED') {
    await tx.client.query(`UPDATE ari.approval_requests SET status = 'REJECTED' WHERE id = $1`, [input.approvalId]);
    return { ok: true, status: 'REJECTED', votes: 0 };
  }

  const tally = await tx.client.query<{ count: string }>(
    `SELECT count(*) AS count FROM ari.approvals
      WHERE approval_request_id = $1 AND decision = 'APPROVED'`,
    [input.approvalId],
  );
  const votes = Number(tally.rows[0]?.count ?? '0');
  if (votes >= request.quorum_needed) {
    await tx.client.query(`UPDATE ari.approval_requests SET status = 'GRANTED' WHERE id = $1`, [input.approvalId]);
    return { ok: true, status: 'GRANTED', votes };
  }
  return { ok: true, status: 'PENDING', votes };
}

function quorumOf(request: { quorum_needed: number }): number {
  return request.quorum_needed;
}

/**
 * `eventType` is chosen by the caller rather than fixed here, because these are two
 * different incidents: a claim that was never valid, and a token that was already
 * spent. The second is the one that means replay, and it must not be flattened into
 * the first.
 */
function refusalEvent(
  tx: TenantTx,
  approvalId: string,
  eventType: 'approval.claim_refused' | 'approval_reuse_attempted',
  code: ReasonCode,
  detail: string,
) {
  return {
    orgId: tx.orgId,
    actor: 'system',
    actorType: 'system' as const,
    eventType,
    resource: 'approval_request',
    resourceId: approvalId,
    severity: 'critical' as const,
    reasonCodes: [code],
    metadata: { code, detail: detail.slice(0, 500) },
  };
}

async function roleOf(tx: TenantTx, userId: string): Promise<string | null> {
  const rows = await tx.client.query<{ role: string }>(
    `SELECT role FROM ari.memberships WHERE user_id = $1 AND org_id = $2`,
    [userId, tx.orgId],
  );
  return rows.rows[0]?.role ?? null;
}

export type ClaimResult =
  | { readonly ok: true; readonly approvalId: string; readonly digest: CanonicalDigest }
  | { readonly ok: false; readonly code: ReasonCode; readonly detail: string };

/**
 * Spend an approval. The decision plane calls this immediately before it mints a
 * ticket, and nothing about it throws.
 *
 * A refusal is a decision, and a decision has to be witnessed (S10, A11): throwing
 * would let the caller's whole transaction roll back, taking the
 * `approval_reuse_attempted` event with it — which is the one event that turns a
 * "why did this fail twice" support thread into a detectable replay.
 */
export async function claimApproval(
  pool: Connector,
  orgId: string,
  token: string,
  presentedDigest: CanonicalDigest,
  key: ApprovalKey,
): Promise<ClaimResult> {
  return asTenant(pool, orgId, (tx) => spendApproval(tx, token, presentedDigest, key));
}

/**
 * The claim itself, in a transaction the caller already holds.
 *
 * Split from `claimApproval` for a reason that is easy to miss: opening a second
 * transaction from inside the first deadlocks on the organisation's advisory chain
 * lock, because the outer transaction holds it and the inner one is waiting for it
 * while the outer waits for the inner. The pipeline authorises, spends the approval
 * and mints the ticket in one unit of work, so it needs this form.
 */
export async function spendApproval(
  tx: TenantTx,
  token: string,
  presentedDigest: CanonicalDigest,
  key: ApprovalKey,
): Promise<ClaimResult> {
  const opened = openApproval(token, key);
    if (!opened.ok) {
      return { ok: false, code: 'APPROVAL_NOT_FOUND', detail: `token is not a valid seal: ${opened.reason}` };
    }
    const claims = opened.claims;

    if (claims.digest !== presentedDigest) {
      // The bytes being authorised are not the bytes the human approved. Nothing else
      // in this system matters as much as this line refusing (T11, T12).
      await appendEvent(tx, refusalEvent(tx, claims.approvalId, 'approval.claim_refused', 'APPROVAL_DIGEST_MISMATCH', 'the presented digest differs from the approved one'));
      return { ok: false, code: 'APPROVAL_DIGEST_MISMATCH', detail: 'digest differs' };
    }

    const spent = await tx.client.query<{ digest: string }>(
      `UPDATE ari.approval_requests
          SET status = 'CONSUMED', consumed_at = now()
        WHERE id = $1 AND org_id = $2 AND status = 'GRANTED' AND digest = $3 AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING digest`,
      [claims.approvalId, tx.orgId, claims.digest],
    );
    if ((spent.rowCount ?? 0) > 0) {
      await appendEvent(tx, {
        orgId: tx.orgId,
        actor: claims.requestId,
        actorType: 'system',
        eventType: 'approval.granted',
        resource: 'approval_request',
        resourceId: claims.approvalId,
        metadata: { digestRef: claims.digest.slice(0, 24) },
      });
      return { ok: true, approvalId: claims.approvalId, digest: claims.digest };
    }

    const why = await tx.client.query<{ status: ApprovalStatus; expired: boolean }>(
      `SELECT status, expires_at <= now() AS expired FROM ari.approval_requests WHERE id = $1 AND org_id = $2`,
      [claims.approvalId, tx.orgId],
    );
    const row = why.rows[0];
    const current = row?.status;
    if (current === undefined) return { ok: false, code: 'APPROVAL_NOT_FOUND', detail: 'not in this organisation' };
    // The window closes on a `PENDING` approval too, and saying
    // "the votes are not in yet" about one nobody can now cast would send an operator
    // to chase an approver who has nothing left to approve.
    if (row?.expired === true) {
      await appendEvent(tx, refusalEvent(tx, claims.approvalId, 'approval.claim_refused', 'APPROVAL_EXPIRED', 'the window closed before quorum'));
      return { ok: false, code: 'APPROVAL_EXPIRED', detail: 'expired while pending' };
    }
    if (current === 'CONSUMED') {
      await appendEvent(tx, refusalEvent(tx, claims.approvalId, 'approval_reuse_attempted', 'APPROVAL_ALREADY_CONSUMED', 'a second presentation of a spent approval'));
      return { ok: false, code: 'APPROVAL_ALREADY_CONSUMED', detail: 'already spent' };
    }
    if (current === 'PENDING') {
      return { ok: false, code: 'QUORUM_NOT_REACHED', detail: 'the votes are not in yet' };
    }
    return { ok: false, code: 'APPROVAL_EXPIRED', detail: `approval is ${current}` };
}

export { ApprovalKey, openApproval, sealApproval, type ApprovalClaims } from './token.js';

/**
 * Seal the token for an approval that has reached quorum, from the row.
 *
 * The pipeline hands back `requestApproval`'s token to nobody — the escalation response
 * goes to the agent, and the agent is the subject being restricted — so a granted
 * approval had no way to become spendable by anything but the operator's own process.
 * This is the other half: called from the approver's request, *after* the vote that
 * reached quorum, and the token goes to the human whose decision it records.
 *
 * Sealed from the row rather than from the caller, for the reason that governs every
 * digest in this system: the fields a token binds are the fields that make it a
 * capability, and a caller that could state them could present any approval it liked as
 * one it held. `requestApproval`'s own return value stays exactly as it was — this is
 * not a second way to mint an approval, it is the one way to collect a decision that was
 * already made.
 *
 * Returns null when the row is not `GRANTED`, so a race between two approvers reaching
 * quorum at the same instant cannot produce a token for the loser of it: the row's
 * status is read under the same lock `recordDecision` took to count the vote.
 */
export async function sealGrantedApproval(
  tx: TenantTx,
  approvalId: string,
  key: ApprovalKey,
): Promise<string | null> {
  const row = await tx.client.query<{
    subject_kind: ApprovalSubject;
    subject_id: string;
    digest: string;
    policy_version_id: string;
    agent_id: string;
    wallet_id: string;
    amount_raw: string | null;
    currency_unit: string;
    expires_at: Date;
    status: ApprovalStatus;
  }>(
    `SELECT subject_kind, subject_id, digest, policy_version_id, agent_id, wallet_id,
            amount_raw, currency_unit, expires_at, status
       FROM ari.approval_requests
      WHERE id = $1 AND org_id = $2
      FOR UPDATE`,
    [approvalId, tx.orgId],
  );
  const granted = row.rows[0];
  if (granted === undefined || granted.status !== 'GRANTED') return null;

  // `randomBytes` rather than a counter: the nonce exists so that two seals of one
  // set of claims are different strings, and a predictable one would make the token a
  // sequence number an attacker could guess into an unrelated approval.
  const claims: ApprovalClaims = {
    approvalId,
    requestId: granted.subject_id,
    digest: granted.digest as CanonicalDigest,
    policyVersionId: granted.policy_version_id,
    agentId: granted.agent_id,
    walletId: granted.wallet_id,
    // The same rule as the row: `null` is "no amount is involved", which the token cannot
    // carry, so it binds zero — and the digest is what a presentation is actually checked
    // against, not this field.
    amountRaw: granted.amount_raw === null ? 0n : BigInt(granted.amount_raw),
    currencyUnit: granted.currency_unit,
    expiresAtMs: BigInt(granted.expires_at.getTime()),
    nonce: randomBytes(12).toString('base64url'),
  };
  return sealApproval(claims, key);
}

/**
 * What one approver has outstanding.
 *
 * The filter is the authority, expressed once: a pending request whose window is still
 * open, whose `allowed_roles` name this person's role, and — for the one subject kind
 * where it bites — not a change this person proposed. That last clause is T19 in a
 * `SELECT`, and it belongs here rather than only in `recordDecision` because showing an
 * approver a request they are forbidden to approve invites them to try, and a queue that
 * contains work nobody can do is not a queue.
 *
 * `allowed_roles` is matched against the role the *membership* holds today, not against
 * what a credential claimed at issue time: authority is read from the row that is
 * authoritative when the question is asked.
 */
export interface ApprovalSummary {
  readonly approvalId: string;
  readonly subjectKind: ApprovalSubject;
  readonly subjectId: string;
  readonly digest: string;
  readonly amountRaw: string | null;
  readonly currencyUnit: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly policyVersionId: string;
  readonly quorumNeeded: number;
  readonly approved: number;
  readonly expiresAt: string;
  readonly requestedBy: string;
}

export async function listApprovals(
  tx: TenantTx,
  input: { readonly userId: string; readonly limit?: number },
): Promise<readonly ApprovalSummary[]> {
  const role = await roleOf(tx, input.userId);
  if (role === null) return [];
  const rows = await tx.client.query<{
    id: string;
    subject_kind: ApprovalSubject;
    subject_id: string;
    digest: string;
    amount_raw: string | null;
    currency_unit: string;
    agent_id: string;
    wallet_id: string;
    policy_version_id: string;
    quorum_needed: number;
    approved: number;
    expires_at: Date;
    requested_by: string;
  }>(
    `SELECT r.id, r.subject_kind, r.subject_id, r.digest, r.amount_raw, r.currency_unit,
            r.agent_id, r.wallet_id, r.policy_version_id, r.quorum_needed, r.expires_at,
            r.requested_by,
            (SELECT count(*)::int FROM ari.approvals a
              WHERE a.approval_request_id = r.id AND a.decision = 'APPROVED') AS approved
       FROM ari.approval_requests r
      WHERE r.org_id = $1
        AND r.status = 'PENDING'
        AND r.expires_at > now()
        AND $2 = ANY (r.allowed_roles)
        AND NOT (r.subject_kind = 'policy_activation' AND r.requested_by = $3)
      ORDER BY r.expires_at, r.created_at
      LIMIT $4`,
    [tx.orgId, role, input.userId, input.limit ?? 50],
  );
  return rows.rows.map((row) => ({
    approvalId: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    digest: row.digest,
    amountRaw: row.amount_raw,
    currencyUnit: row.currency_unit,
    agentId: row.agent_id,
    walletId: row.wallet_id,
    policyVersionId: row.policy_version_id,
    quorumNeeded: row.quorum_needed,
    approved: row.approved,
    expiresAt: row.expires_at.toISOString(),
    requestedBy: row.requested_by,
  }));
}

/**
 * One approval, with its votes.
 *
 * The votes are returned because an approver deciding without seeing who else decided is
 * guessing at quorum, and because the roster is the artifact a support thread needs:
 * "who said yes to this" is answerable from the API, not from a database session.
 */
export interface ApprovalDetail extends ApprovalSummary {
  readonly status: ApprovalStatus;
  readonly votes: readonly { readonly approver: string; readonly role: string; readonly decision: string; readonly at: string }[];
}

export async function approvalDetail(tx: TenantTx, approvalId: string): Promise<ApprovalDetail | null> {
  const head = await tx.client.query<{
    id: string;
    subject_kind: ApprovalSubject;
    subject_id: string;
    digest: string;
    amount_raw: string | null;
    currency_unit: string;
    agent_id: string;
    wallet_id: string;
    policy_version_id: string;
    quorum_needed: number;
    expires_at: Date;
    requested_by: string;
    status: ApprovalStatus;
  }>(
    `SELECT id, subject_kind, subject_id, digest, amount_raw, currency_unit, agent_id, wallet_id,
            policy_version_id, quorum_needed, expires_at, requested_by, status
       FROM ari.approval_requests
      WHERE id = $1 AND org_id = $2`,
    [approvalId, tx.orgId],
  );
  const row = head.rows[0];
  if (row === undefined) return null;

  const votes = await tx.client.query<{
    approver_user_id: string;
    role: string;
    decision: string;
    decided_at: Date;
  }>(
    `SELECT approver_user_id, role, decision, decided_at FROM ari.approvals
      WHERE approval_request_id = $1 AND org_id = $2 ORDER BY decided_at`,
    [approvalId, tx.orgId],
  );

  return {
    approvalId: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    digest: row.digest,
    amountRaw: row.amount_raw,
    currencyUnit: row.currency_unit,
    agentId: row.agent_id,
    walletId: row.wallet_id,
    policyVersionId: row.policy_version_id,
    quorumNeeded: row.quorum_needed,
    approved: votes.rows.filter((v) => v.decision === 'APPROVED').length,
    expiresAt: row.expires_at.toISOString(),
    requestedBy: row.requested_by,
    status: row.status,
    votes: votes.rows.map((v) => ({
      approver: v.approver_user_id,
      role: v.role,
      decision: v.decision,
      at: v.decided_at.toISOString(),
    })),
  };
}
