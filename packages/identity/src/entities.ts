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
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO ari.organizations (id, name) VALUES ($1, $2)`,
      [id, input.name.trim()],
    );
    await appendEvent({ client }, {
      orgId: id,
      actor: input.bootstrapActor,
      actorType: 'system',
      eventType: 'organization.created',
      resource: 'organization',
      resourceId: id,
      metadata: {},
    });
  } finally {
    client.release();
  }
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
    metadata: { actorRole: input.role },
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
): Promise<{ readonly id: string; readonly reused: boolean }> {
  const inserted = await tx.client.query<{ id: string }>(
    `INSERT INTO ari.transaction_requests
       (id, org_id, agent_id, wallet_id, idempotency_key, canonical, digest,
        recipient_address, amount_raw, currency_unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (agent_id, idempotency_key) DO NOTHING
     RETURNING id`,
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
  if (fresh !== undefined) return { id: fresh.id, reused: false };

  const existing = await tx.client.query<{ id: string; digest: string }>(
    `SELECT id, digest FROM ari.transaction_requests WHERE agent_id = $1 AND idempotency_key = $2`,
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
  return { id: row.id, reused: true };
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
  await audit(tx, {
    eventType: 'transaction.proposed',
    actor: input.actor,
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
    status:
      row.revoked_at !== null && row.revoked_at.getTime() <= now
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
  readonly scopes: readonly string[];
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
    scopes: [],
  };
}

/** The credential scopes an agent currently holds, for the engine's identity stage. */
export async function activeScopes(tx: TenantTx, credentialId: string): Promise<readonly string[]> {
  const rows = await tx.client.query<{ scopes: string[] }>(
    `SELECT scopes FROM ari.agent_credentials
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [credentialId, tx.orgId],
  );
  return rows.rows[0]?.scopes ?? [];
}

/**
 * The behavioural history the escalation rules ask about.
 *
 * Recipients are derived from what has already *settled* — a recipient a policy
 * approved once is no longer novel — and `firstSeenWithinDays` is a real window
 * rather than a boolean, because `recipient_first_seen_within_days` says days and
 * answering it with "have we ever paid them" is a different question.
 */
export async function recipientHistory(
  tx: TenantTx,
  walletId: string,
): Promise<{ readonly known: ReadonlySet<string>; readonly firstSeenWithinDays: (address: string, days: number) => boolean }> {
  const rows = await tx.client.query<{ address: string; first_seen: Date }>(
    `SELECT recipient_address AS address, min(created_at) AS first_seen FROM ari.transaction_requests
      WHERE wallet_id = $1 AND org_id = $2 AND recipient_address IS NOT NULL
        AND lifecycle_state IN ('SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED')
      GROUP BY recipient_address`,
    [walletId, tx.orgId],
  );
  const seen = new Map<string, number>();
  for (const row of rows.rows) {
    const at = row.first_seen.getTime();
    const prior = seen.get(row.address);
    if (prior === undefined || at < prior) seen.set(row.address, at);
  }
  const now = Number(tx.startedAtMs);
  return {
    known: new Set(seen.keys()),
    firstSeenWithinDays: (address, days) => {
      const at = seen.get(address);
      return at !== undefined && now - at <= days * 86_400_000;
    },
  };
}
