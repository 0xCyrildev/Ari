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
  readonly amountRaw: bigint;
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
    amountRaw: input.amountRaw,
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
      input.amountRaw.toString(),
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
    metadata: { amountRaw: input.amountRaw.toString(), assetUnit: input.currencyUnit },
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
    allowed_roles: string[];
    requested_by: string;
    subject_kind: ApprovalSubject;
    quorum_needed: number;
    digest: string;
  }>(
    `SELECT status, expires_at, allowed_roles, requested_by, subject_kind, quorum_needed, digest
       FROM ari.approval_requests WHERE id = $1 FOR UPDATE`,
    [input.approvalId],
  );
  const request = locked.rows[0];
  if (request === undefined) return { ok: false, code: 'APPROVAL_NOT_FOUND', detail: 'no such approval' };

  if (request.status !== 'PENDING') {
    return { ok: false, code: 'APPROVAL_ALREADY_CONSUMED', detail: `approval is ${request.status}` };
  }
  if (request.expires_at.getTime() <= Number(tx.startedAtMs)) {
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

    if (claims.expiresAtMs <= tx.startedAtMs) {
      await appendEvent(tx, refusalEvent(tx, claims.approvalId, 'approval.claim_refused', 'APPROVAL_EXPIRED', 'presented after its expiry'));
      return { ok: false, code: 'APPROVAL_EXPIRED', detail: 'expired' };
    }
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

    const why = await tx.client.query<{ status: ApprovalStatus }>(
      `SELECT status FROM ari.approval_requests WHERE id = $1 AND org_id = $2`,
      [claims.approvalId, tx.orgId],
    );
    const current = why.rows[0]?.status;
    if (current === undefined) return { ok: false, code: 'APPROVAL_NOT_FOUND', detail: 'not in this organisation' };
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
