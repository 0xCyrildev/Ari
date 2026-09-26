/**
 * Tenancy and the objects a policy binds to — organizations, users, agents,
 * wallets, grants, requests.
 *
 * Every function here takes a `TenantTx`, so a cross-tenant read is a compile
 * error before it is a row-security question, and every state change that a later
 * investigator will ask about writes its audit event in the same transaction
 * (S10). The event is written inside the function rather than by its caller for
 * the same reason the reservation and the outbox commit together: an obligation
 * that lives in documentation is discharged by whoever remembers.
 */

import { newId } from '@ari/schemas';
import { appendEvent, type AuditEventTypeValue, type SafeLogFields } from '@ari/audit';
import type { Connector, Scope, TenantTx } from './tenant.js';
import { asTenant } from './tenant.js';

export type UserRole = 'owner' | 'admin' | 'approver' | 'viewer';
export type AgentStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED';
export type WalletMode = 'delegated' | 'user_gated';
export type CredentialStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

async function audit(
  tx: TenantTx,
  input: {
    readonly eventType: AuditEventTypeValue;
    readonly actor: string;
    readonly actorType?: 'human' | 'agent' | 'system';
    readonly resource?: string;
    readonly resourceId?: string;
    readonly severity?: 'info' | 'notice' | 'warning' | 'critical';
    readonly metadata?: SafeLogFields;
    readonly reasonCodes?: readonly string[];
  },
): Promise<void> {
  // Conditional spreads throughout, because `exactOptionalPropertyTypes` is on and
  // a field explicitly set to undefined is a different statement from a field that
  // is absent — the difference an audit reader is entitled to rely on.
  await appendEvent(tx, {
    orgId: tx.orgId,
    actor: input.actor,
    actorType: input.actorType ?? 'human',
    eventType: input.eventType,
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    severity: input.severity ?? 'info',
    metadata: input.metadata ?? {},
    ...(input.reasonCodes === undefined ? {} : { reasonCodes: input.reasonCodes }),
  });
}

/**
 * Create an organisation. The one write with no tenant to scope by, so it runs
 * outside `asTenant` and behind the bootstrap credential (§5.6): an open
 * `POST /v1/organizations` is a tenant-spam surface, and the brief's own example
 * shipped one.
 */
export async function createOrganization(
  pool: Connector,
  input: { readonly name: string; readonly bootstrapActor: string },
): Promise<string> {
  if (input.name.trim().length === 0) throw new RangeError('an organisation needs a name');
  const id = newId('org');
  // One transaction, and inside the tenant scope, for two reasons that are the same
  // reason: the organisation row and the event recording its creation either both exist
  // or neither does — an `organizations` row with no `organization.created` event is a
  // tenant that appears to have no beginning — and `ari.audit_events` is under row
  // security like every other tenant table, so the write has to carry the scope that
  // policy reads. There is no "bootstrap connections skip the policy" carve-out here:
  // that is the hole, not the workaround.
  await asTenant(pool, id, async (tx) => {
    await tx.client.query(`INSERT INTO ari.organizations (id, name) VALUES ($1, $2)`, [id, input.name.trim()]);
    await appendEvent(tx, {
      orgId: id,
      actor: input.bootstrapActor,
      actorType: 'system',
      eventType: 'organization.created',
      resource: 'organization',
      resourceId: id,
      metadata: {},
    });
  });
  return id;
}

export async function createUser(
  tx: TenantTx,
  input: { readonly email: string; readonly displayName: string; readonly role: UserRole; readonly grantedBy: string },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RangeError('email is not an email');
  const id = newId('usr');
  await tx.client.query(
    `INSERT INTO ari.users (id, org_id, email, display_name) VALUES ($1, $2, $3, $4)`,
    [id, tx.orgId, email, input.displayName],
  );
  await tx.client.query(
    `INSERT INTO ari.memberships (user_id, org_id, role, granted_by) VALUES ($1, $2, $3, $4)`,
    [id, tx.orgId, input.role, input.grantedBy],
  );
  await audit(tx, {
    eventType: 'user.created',
    actor: input.grantedBy,
    resource: 'user',
    resourceId: id,
    metadata: { actorRole: input.role },
  });
  return id;
}

export async function changeUserRole(
  tx: TenantTx,
  input: { readonly userId: string; readonly role: UserRole; readonly actor: string },
): Promise<void> {
  // Lock the row being replaced before deleting and re-inserting it. Without this, two
  // concurrent changes read the same membership, both delete (one blocks on the other's
  // lock and then deletes *nothing*, having already decided what the old role was), and
  // both insert — and the role that the second audit event reports as `from` was never
  // what the row held. The organisation's advisory lock already serialises tenants from
  // each other; this is the one that keeps two changes to the *same* membership ordered.
  const current = await tx.client.query<{ role: string }>(
    `SELECT role FROM ari.memberships WHERE user_id = $1 AND org_id = $2 FOR UPDATE`,
    [input.userId, tx.orgId],
  );
  const from = current.rows[0]?.role ?? 'none';

  await tx.client.query(`DELETE FROM ari.memberships WHERE user_id = $1 AND org_id = $2`, [input.userId, tx.orgId]);
  await tx.client.query(
    `INSERT INTO ari.memberships (user_id, org_id, role, granted_by) VALUES ($1, $2, $3, $4)`,
    [input.userId, tx.orgId, input.role, input.actor],
  );
  // A role change is an authority change, and this is the event the colony map
  // highlights: someone can now do something they could not do an hour ago.
  await audit(tx, {
    eventType: 'user.role_changed',
    actor: input.actor,
    resource: 'user',
    resourceId: input.userId,
    severity: 'warning',
    metadata: { actorRole: input.role, fromState: from },
  });
}

export async function createAgent(
  tx: TenantTx,
  input: { readonly name: string; readonly createdBy: string },
): Promise<string> {
  const id = newId('agt');
  await tx.client.query(
    `INSERT INTO ari.agents (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)`,
    [id, tx.orgId, input.name, input.createdBy],
  );
  await audit(tx, {
    eventType: 'agent.created',
    actor: input.createdBy,
    resource: 'agent',
    resourceId: id,
    metadata: { policyName: input.name },
  });
  return id;
}

/**
 * Pause, resume or retire an agent.
 *
 * `REVOKED` is terminal and absorbs: an agent that has been retired cannot be
 * brought back, because the credential history and the grants underneath it would
 * have to be re-trusted rather than re-examined. A new agent is the correct move,
 * and it costs one command.
 */
export async function setAgentStatus(
  tx: TenantTx,
  input: { readonly agentId: string; readonly status: AgentStatus; readonly actor: string },
): Promise<void> {
  const current = await tx.client.query<{ status: string }>(
    `SELECT status FROM ari.agents WHERE id = $1 AND org_id = $2`,
    [input.agentId, tx.orgId],
  );
  const before = current.rows[0]?.status;
  if (before === undefined) throw new Error('agent not found in this organisation');
  if (before === 'REVOKED') throw new Error('a revoked agent cannot change status; create a new one');

  await tx.client.query(
    `UPDATE ari.agents SET status = $2, revoked_at = CASE WHEN $2 = 'REVOKED' THEN now() ELSE revoked_at END
      WHERE id = $1 AND org_id = $3`,
    [input.agentId, input.status, tx.orgId],
  );
  // Revoking an agent also takes its credentials with it, or the status check in
  // `verifyCredential` becomes the only thing standing between a leaked secret and
  // a payment — and single checks break.
  if (input.status === 'REVOKED') {
    await tx.client.query(
      `UPDATE ari.agent_credentials SET revoked_at = now()
        WHERE agent_id = $1 AND org_id = $2 AND revoked_at IS NULL`,
      [input.agentId, tx.orgId],
    );
  }
  await audit(tx, {
    eventType: input.status === 'REVOKED' ? 'agent.revoked' : 'agent.paused',
    actor: input.actor,
    resource: 'agent',
    resourceId: input.agentId,
    severity: input.status === 'REVOKED' ? 'warning' : 'info',
    metadata: { fromState: before, toState: input.status },
  });
}

export async function createWallet(
  tx: TenantTx,
  input: {
    readonly displayName: string;
    readonly mode: WalletMode;
    readonly signatureTriple: string;
    readonly provider: string;
    readonly actor: string;
  },
): Promise<string> {
  const id = newId('wal');
  await tx.client.query(
    `INSERT INTO ari.wallets (id, org_id, display_name, mode, signature_triple, provider)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tx.orgId, input.displayName, input.mode, input.signatureTriple, input.provider],
  );
  await audit(tx, {
    eventType: 'wallet.created',
    actor: input.actor,
    resource: 'wallet',
    resourceId: id,
    // `delegated` is the weaker guarantee and the irreversible one, so it is
    // recorded at a higher severity: the dashboard's colony map reads this event
    // stream, and "which wallet can be moved by software alone" is the question.
    severity: input.mode === 'delegated' ? 'warning' : 'info',
    metadata: { walletMode: input.mode },
  });
  return id;
}

export async function grantWalletToAgent(
  tx: TenantTx,
  input: { readonly agentId: string; readonly walletId: string; readonly policyVersionId: string; readonly actor: string },
): Promise<void> {
  await tx.client.query(
    `INSERT INTO ari.agent_wallet_grants (agent_id, wallet_id, org_id, policy_version_id, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_id, wallet_id)
     DO UPDATE SET policy_version_id = EXCLUDED.policy_version_id,
                   revoked_at = NULL,
                   granted_by = EXCLUDED.granted_by,
                   granted_at = now()`,
    [input.agentId, input.walletId, tx.orgId, input.policyVersionId, input.actor],
  );
  await audit(tx, {
    eventType: 'wallet.granted',
    actor: input.actor,
    resource: 'grant',
    resourceId: `${input.agentId}+${input.walletId}`,
    severity: 'warning',
    metadata: { policyName: input.policyVersionId },
  });
}

/**
 * Record a request, or return the one this retry already made.
 *
 * The unique key is `(agent_id, idempotency_key)` and the resolution is a
 * lookup rather than an error, because a client that retried after a timeout needs
 * its original answer, not a 409 to explain to a user.
 */
export async function recordRequest(
  tx: TenantTx,
  input: {
    readonly agentId: string;
    readonly walletId: string;
    readonly idempotencyKey: string;
    readonly canonical: string;
    readonly digest: string;
    /**
     * Derived from the same candidate the digest was computed over, and optional
     * because not every candidate has a recipient or an amount a policy reads as
     * money — a contract call has neither, and recording `null` for those is the
     * honest answer rather than a zero that a later sum would count.
     */
    readonly recipientAddress?: string;
    readonly amountRaw?: bigint;
    readonly currencyUnit?: string;
  },
): Promise<{ readonly id: string; readonly reused: boolean; readonly lifecycleState: string }> {
  // `lifecycle_state` comes back with the row because the caller needs it and it is not
  // worth a second statement to learn the state this same transaction just set.
  const inserted = await tx.client.query<{ id: string; lifecycle_state: string }>(
    `INSERT INTO ari.transaction_requests
       (id, org_id, agent_id, wallet_id, idempotency_key, canonical, digest,
        recipient_address, amount_raw, currency_unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (agent_id, idempotency_key) DO NOTHING
     RETURNING id, lifecycle_state`,
    [
      newId('txr'),
      tx.orgId,
      input.agentId,
      input.walletId,
      input.idempotencyKey,
      input.canonical,
      input.digest,
      input.recipientAddress ?? null,
      input.amountRaw === undefined ? null : input.amountRaw.toString(),
      input.currencyUnit ?? null,
    ],
  );
  const fresh = inserted.rows[0];
  if (fresh === undefined) {
    // fall through to the reuse lookup below
  } else {
    // A proposal is its own event, on the one path where something was actually
    // proposed: a retry finds the existing row and writes nothing.
    await audit(tx, {
      eventType: 'transaction.proposed',
      actor: input.agentId,
      actorType: 'agent',
      resource: 'transaction_request',
      resourceId: fresh.id,
      metadata: {
        digestRef: input.digest.slice(0, 24),
        ...(input.amountRaw === undefined ? {} : { amountRaw: input.amountRaw.toString() }),
        ...(input.currencyUnit === undefined ? {} : { assetUnit: input.currencyUnit }),
        ...(input.recipientAddress === undefined ? {} : { recipientAddress: input.recipientAddress }),
      },
    });
    // A row this transaction just wrote is `DRAFT` by column default.
    return { id: fresh.id, reused: false, lifecycleState: fresh.lifecycle_state };
  }

  const existing = await tx.client.query<{ id: string; digest: string; lifecycle_state: string }>(
    `SELECT id, digest, lifecycle_state FROM ari.transaction_requests WHERE agent_id = $1 AND idempotency_key = $2`,
    [input.agentId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new Error('idempotency key claimed with no request behind it');
  if (row.digest !== input.digest) {
    // The key is a promise that this is the same request. A different transaction
    // arriving under the same key is either a client bug or an attempt to get a
    // second decision to cover a different payment, and neither deserves a
    // best-effort answer.
    throw new Error('idempotency conflict: same key, different transaction');
  }
  return { id: row.id, reused: true, lifecycleState: row.lifecycle_state };
}

export async function setRequestState(
  tx: TenantTx,
  input: { readonly requestId: string; readonly from: string; readonly to: string; readonly actor: string },
): Promise<void> {
  const moved = await tx.client.query(
    `UPDATE ari.transaction_requests SET lifecycle_state = $2, updated_at = now()
      WHERE id = $1 AND lifecycle_state = $3 AND org_id = $4
      RETURNING id`,
    [input.requestId, input.to, input.from, tx.orgId],
  );
  if ((moved.rowCount ?? 0) === 0) {
    // Compare-and-set, not "write the state you wanted": two workers advancing one
    // request is how a denied transaction gets signed by the loser of a race.
    throw new Error(`request ${input.requestId} is not in ${input.from}`);
  }
  // `transaction.state_changed`, not `transaction.proposed`. The lifecycle writer used
  // to label every step — DRAFT→VALIDATED, EVALUATING→RESERVED, RESERVED→TICKET_MINTED —
  // as a proposal, so four rows in the trail per payment all said the same untrue thing:
  // that an agent had proposed a transaction. An auditor reading the trail afterwards is
  // looking for *when what happened*; a mislabelled event type is worse than a missing
  // one, because it reads as evidence.
  await audit(tx, {
    eventType: 'transaction.state_changed',
    actor: input.actor,
    actorType: input.actor === 'system' ? 'system' : 'agent',
    resource: 'transaction_request',
    resourceId: input.requestId,
    metadata: { fromState: input.from, toState: input.to },
  });
}

/** Which credentials an agent can still act with — the stale-capability report (T8). */
export async function listCredentials(
  tx: TenantTx,
  agentId: string,
): Promise<readonly { readonly id: string; readonly scopes: readonly Scope[]; readonly status: CredentialStatus }[]> {
  const rows = await tx.client.query<{
    id: string;
    scopes: string[];
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, scopes, expires_at, revoked_at FROM ari.agent_credentials
      WHERE agent_id = $1 AND org_id = $2 ORDER BY created_at DESC`,
    [agentId, tx.orgId],
  );
  const now = Number(tx.startedAtMs);
  return rows.rows.map((row) => ({
    id: row.id,
    scopes: row.scopes as Scope[],
    // A revocation is a fact, not a scheduled event: `revoked_at <= now` would have read
    // a revocation stamped a few milliseconds ahead of this process's clock as a live
    // credential, which is the one classification this report exists to get right. The
    // expiry comparison stays on the clock because expiry *is* a time — and that one is a
    // report, not the authorizing read, which is `verifyCredential`'s and `activeScopes`'
    // business.
    // Revocation outranks expiry. The old order reported a revoked *and* expired
    // credential as EXPIRED, which is the classification that invites "it would have
    // lapsed anyway" about the one event an incident review is asking about.
    status:
      row.revoked_at !== null
        ? 'REVOKED'
        : row.expires_at.getTime() <= now
          ? 'EXPIRED'
          : ('ACTIVE' as const),
  }));
}

export { asTenant };
export type { TenantTx, Connector, Scope };

export interface ResolvedGrant {
  readonly agentId: string;
  readonly agentStatus: AgentStatus;
  readonly walletId: string;
  readonly walletMode: WalletMode;
  readonly signatureTriple: string;
  readonly policyVersionId: string;
}

/**
 * What an agent is allowed to act on, and under which policy.
 *
 * The join the whole pipeline starts from, and the reason it is one query: a grant
 * that is missing, revoked, or pointing at a policy version that no longer exists
 * has to look the same from the outside — no authority — rather than resolve to
 * whatever the last cached lookup said. Revocation taking effect on the next request
 * (S14) is a property of this read, not of a session layer.
 */
export async function resolveGrant(
  tx: TenantTx,
  input: { readonly agentId: string; readonly walletId: string },
): Promise<ResolvedGrant | null> {
  const rows = await tx.client.query<{
    agent_status: AgentStatus;
    wallet_mode: WalletMode;
    signature_triple: string;
    policy_version_id: string;
  }>(
    `SELECT a.status AS agent_status, w.mode AS wallet_mode, w.signature_triple,
            g.policy_version_id
       FROM ari.agent_wallet_grants g
       JOIN ari.agents a ON a.id = g.agent_id AND a.org_id = g.org_id
       JOIN ari.wallets w ON w.id = g.wallet_id AND w.org_id = g.org_id
      WHERE g.agent_id = $1 AND g.wallet_id = $2 AND g.org_id = $3
        AND g.revoked_at IS NULL`,
    [input.agentId, input.walletId, tx.orgId],
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  return {
    agentId: input.agentId,
    agentStatus: row.agent_status,
    walletId: input.walletId,
    walletMode: row.wallet_mode,
    signatureTriple: row.signature_triple,
    policyVersionId: row.policy_version_id,
  };
}

/**
 * The credential scopes an agent currently holds, for the engine's identity stage.
 *
 * A live credential, on the database's clock: `revoked_at IS NULL AND expires_at > now()`.
 * The gateway's `verifyCredential` answers the same question with the process clock a few
 * lines earlier, and the two are allowed to disagree in exactly one direction — an
 * authentication that a stale clock let through still has to find scopes here, inside the
 * tenant transaction, where a revoked or expired credential yields none and the kernel
 * denies with `SCOPE_MISSING`. Divergence lands on a refusal, which is the only ordering
 * that is safe to leave in place.
 */
export async function activeScopes(tx: TenantTx, credentialId: string): Promise<readonly string[]> {
  const rows = await tx.client.query<{ scopes: string[] }>(
    `SELECT scopes FROM ari.agent_credentials
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [credentialId, tx.orgId],
  );
  return rows.rows[0]?.scopes ?? [];
}

/**
 * When this wallet first paid this address, in settled money — or never.
 *
 * One indexed probe on the recipient index, for one address. It used to be
 * `recipientHistory`, which grouped every recipient the wallet had ever paid into a Set
 * and a Map so the caller could ask about one of them, and the set it built was read by
 * nothing: the kernel asks `recipient_first_seen_within_days` about the candidate's
 * recipient and nothing else. An unbounded scan per request, to answer a question about
 * a single address, was the kind of cost that looks free until the tenant is a year old.
 *
 * "Settled" is the definition novelty is measured against — a recipient a policy approved
 * once but whose payment never landed is not familiar. The risk plane counts a *different*
 * population (anything it authorised), and says so in its own module comment; two
 * questions, two answers.
 */
export async function recipientFirstSeenAt(
  tx: TenantTx,
  input: { readonly walletId: string; readonly address: string },
): Promise<bigint | null> {
  const rows = await tx.client.query<{ first_seen: Date | null }>(
    `SELECT min(created_at) AS first_seen FROM ari.transaction_requests
      WHERE wallet_id = $1 AND org_id = $2 AND recipient_address = $3
        AND lifecycle_state IN ('SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED')`,
    [input.walletId, tx.orgId, input.address],
  );
  // Explicit, not `?? null` chained onto a coercion: a `Date` is the only shape this
  // column can come back as, and there is no falsy timestamp to rescue — epoch zero is
  // a real instant that a `|| null` would quietly turn into "never seen".
  const seen = rows.rows[0]?.first_seen;
  return seen instanceof Date && !Number.isNaN(seen.getTime()) ? BigInt(seen.getTime()) : null;
}

export async function requestStateOf(
  tx: TenantTx,
  requestId: string,
): Promise<{ readonly id: string; readonly lifecycleState: string; readonly createdAt: string } | null> {
  const rows = await tx.client.query<{ id: string; lifecycle_state: string; created_at: Date }>(
    `SELECT id, lifecycle_state, created_at FROM ari.transaction_requests WHERE id = $1 AND org_id = $2`,
    [requestId, tx.orgId],
  );
  const row = rows.rows[0];
  return row === undefined
    ? null
    : { id: row.id, lifecycleState: row.lifecycle_state, createdAt: row.created_at.toISOString() };
}

/**
 * The live scopes on a *human's* credential, read inside the tenant transaction.
 *
 * The separate function is the point, not an accident of the two tables: an approver's
 * authority is checked against `user_credentials` and an agent's against
 * `agent_credentials`, and a lookup that could answer for either would make the
 * separation `013` put in a CHECK — the subject that proposes is not the subject that
 * approves — a matter of which function a route handler happened to call.
 */
export async function activeUserScopes(tx: TenantTx, credentialId: string): Promise<readonly string[]> {
  const rows = await tx.client.query<{ scopes: string[] }>(
    `SELECT scopes FROM ari.user_credentials
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [credentialId, tx.orgId],
  );
  return rows.rows[0]?.scopes ?? [];
}
