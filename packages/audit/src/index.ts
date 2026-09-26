/**
 * The audit writer (§11, S10, CC4).
 *
 * Two properties, both of which are about refusal rather than logging:
 *
 *   1. **Redaction is structural.** `SafeLogFields` is a closed set of fields with
 *      no place a credential, private key, secret share or full approval token
 *      can go, and the writer checks the payload's keys against that same list at
 *      runtime. A type alone does not survive a `metadata: someJsonBlob`, and a
 *      denylist of field names is a list of what someone has thought of.
 *   2. **A security decision is witnessed before it is returned.** `appendEvent`
 *      takes the caller's transaction handle. An outbox written on a connection of
 *      its own can lose the record of a decision it is supposed to be evidence for,
 *      and "we decided DENY but cannot show it" is the difference between an audit
 *      trail and a story told afterwards.
 *
 * The hash chain covers the event's content, and deliberately not its `seq` or its
 * `made_at` — both assigned inside Postgres, and a `timestamptz` that round-trips
 * through a different string than it went in would make every recomputed hash a
 * false alarm. Timestamps are still protected: reaching one at all requires an
 * UPDATE or a DELETE, and both are refused by trigger and by grant.
 */

import { newId } from '@ari/schemas';
import { canonicalEncode } from '@ari/transaction-engine';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Anything that can run a read, so verification works against a pool or a client. */
export type AuditReader = Pool | PoolClient;

/** The head of every organisation's chain, so the first event is verifiable too. */
export const GENESIS = 'genesis';

/** `audit/v1` inside the hash, so a later change to the encoding cannot reinterpret history. */
export const AUDIT_HASH_VERSION = 'audit/v1';

export const AuditEventType = [
  'organization.created',
  'user.created',
  'user.role_changed',
  'agent.created',
  'agent.paused',
  'agent.revoked',
  'credential.issued',
  'credential.rotated',
  'credential.revoked',
  'credential.failed',
  'wallet.created',
  'wallet.granted',
  'policy.created',
  'policy.activated',
  'policy.broadened',
  'policy.downgrade_attempted',
  'policy.activation_refused',
  'intent.received',
  'intent.interpreted',
  'intent.clarification_requested',
  'transaction.proposed',
  'transaction.state_changed',
  'transaction.rejected_unparseable',
  'risk.assessed',
  'risk.unavailable',
  'simulation.completed',
  'policy.evaluated',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'approval.expired',
  'approval.claim_refused',
  'approval_reuse_attempted',
  'approval_digest_mismatch',
  'ticket.minted',
  'ticket.redeemed',
  'ticket.refused',
  'signing.requested',
  'signing.succeeded',
  'signing.failed',
  'broadcast.submitted',
  'broadcast.confirmed',
  'reservation.settled',
  'reservation.released',
  'budget.exceeded',
  'evaluation.error',
  'chain.integrity_check',
] as const;

export type AuditEventTypeValue = (typeof AuditEventType)[number];

/**
 * Everything an audit event may say about itself.
 *
 * No field here can hold a secret: every value is a string of bounded length, an
 * address, an id, a hash of something sensitive, or a count. Where an event needs
 * to identify a credential it uses `credentialIdHash` — the one thing you can
 * always log about a secret is a hash of it, which is what makes the trail useful
 * during an incident instead of merely safe.
 */
export interface SafeLogFields {
  readonly reason?: string;
  readonly detail?: string;
  readonly code?: string;
  readonly policyName?: string;
  readonly walletMode?: 'delegated' | 'user_gated';
  readonly amountRaw?: string;
  readonly assetUnit?: string;
  readonly recipientAddress?: string;
  readonly chain?: string;
  readonly assetRef?: string;
  readonly digestRef?: string;
  readonly credentialIdHash?: string;
  readonly credentialId?: string;
  readonly keyId?: string;
  readonly clientId?: string;
  readonly actorRole?: string;
  readonly approverCount?: string;
  readonly fieldsShown?: readonly string[];
  readonly provider?: string;
  readonly fromState?: string;
  readonly toState?: string;
  readonly versionFrom?: string;
  readonly versionTo?: string;
  /**
   * The risk assessment, as the numbers it was computed from. `riskSignals` is the
   * list an approver reads before deciding, and it is bounded by the schema at 50 —
   * never the explanation, which is prose an engine generates rather than a field Ari
   * controls, and has no place in a typed log line.
   */
  readonly riskScore?: string;
  readonly riskLevel?: string;
  readonly riskSignals?: readonly string[];
  readonly riskModel?: string;
}

const ALLOWED_FIELDS: readonly string[] = Object.keys({
  reason: 0,
  detail: 0,
  code: 0,
  policyName: 0,
  walletMode: 0,
  amountRaw: 0,
  assetUnit: 0,
  recipientAddress: 0,
  chain: 0,
  assetRef: 0,
  digestRef: 0,
  credentialIdHash: 0,
  credentialId: 0,
  keyId: 0,
  clientId: 0,
  actorRole: 0,
  approverCount: 0,
  fieldsShown: 0,
  provider: 0,
  fromState: 0,
  toState: 0,
  versionFrom: 0,
  versionTo: 0,
  riskScore: 0,
  riskLevel: 0,
  riskSignals: 0,
  riskModel: 0,
} satisfies Record<keyof SafeLogFields, 0>);

export type AuditSeverity = 'info' | 'notice' | 'warning' | 'critical';

export interface AuditEventInput {
  readonly orgId: string;
  readonly actor: string;
  readonly actorType: 'human' | 'agent' | 'system';
  readonly eventType: AuditEventTypeValue;
  readonly resource?: string;
  readonly resourceId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly policyVersionId?: string;
  readonly decision?: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';
  readonly reasonCodes?: readonly string[];
  readonly severity?: AuditSeverity;
  readonly metadata?: SafeLogFields;
}

export interface AuditEvent extends AuditEventInput {
  readonly id: string;
  readonly prevHash: string;
  readonly hash: string;
}

/**
 * Where the chain's head is, for the duration of one transaction.
 *
 * `appendEvent` used to read it from the table before every insert — three round trips
 * per event, seven events per authorised request, nearly half the request's statements —
 * and re-issued the organisation's advisory lock each time even though `asTenant` takes
 * that lock as the transaction's first statement and holds it to commit.
 *
 * The cache is sound *because* of that lock, not in spite of it: while this transaction
 * holds it, no other transaction can append to this organisation's chain, and the head is
 * exactly the row this transaction wrote last. Keyed by org so a caller that appends for
 * two tenants on one client cannot carry a head from one into the other.
 */
export interface ChainCursor {
  readonly lockHeld: boolean;
  head?: { readonly org: string; readonly hash: string };
}

/** The structurally-compatible subset of `@ari/ledger`'s transaction handle. */
export interface AuditTx {
  readonly client: PoolClient;
  /** Absent on a bare client, where the lock and the head must both be taken per event. */
  readonly chain?: ChainCursor;
}

interface HashableParts {
  readonly id: string;
  readonly org: string;
  readonly actor: string;
  readonly actorType: string;
  readonly eventType: string;
  readonly resource: string | null;
  readonly resourceId: string | null;
  readonly request: string | null;
  readonly correlation: string | null;
  readonly policyVersion: string | null;
  readonly decision: string | null;
  readonly reasons: readonly string[];
  readonly severity: string;
  readonly meta: SafeLogFields;
  readonly prev: string;
}

export function eventHash(parts: HashableParts): string {
  const hex = createHash('sha256').update(canonicalEncode(parts)).digest('hex');
  return `${AUDIT_HASH_VERSION}:${hex}`;
}

/** A bounded, non-secret identifier for a sensitive value: enough to correlate, not enough to use. */
export function secretRef(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function assertRedactable(metadata: SafeLogFields): void {
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      // Loud, not dropped: an event that quietly loses a field is an event whose
      // reader cannot tell what else is missing.
      throw new TypeError(`audit metadata field "${key}" has no place in SafeLogFields`);
    }
  }
}

/**
 * The current head of an organisation's chain.
 *
 * `FOR UPDATE` would lock a row that may not exist yet, so `appendEvent` takes a
 * transaction-scoped advisory lock on the org instead: two writers for the same
 * tenant serialise, two writers for different tenants do not.
 */
async function chainHead(client: PoolClient, orgId: string): Promise<string> {
  const head = await client.query<{ hash: string }>(
    `SELECT hash FROM ari.audit_events WHERE org_id = $1 ORDER BY seq DESC LIMIT 1`,
    [orgId],
  );
  return head.rows[0]?.hash ?? GENESIS;
}

/**
 * Append one event, inside the caller's transaction.
 *
 * Returns the row that was written, so the caller can put its hash in a response
 * or a correlation field without reading it back from a database another
 * transaction may still be about to change.
 */
export async function appendEvent(tx: AuditTx, input: AuditEventInput): Promise<AuditEvent> {
  const metadata = input.metadata ?? {};
  assertRedactable(metadata);
  const reasonCodes = input.reasonCodes ?? [];
  const severity = input.severity ?? 'info';
  const id = newId('aud');

  // Re-entrant when the caller came through `asTenant`, which takes this lock as
  // the first statement of the transaction; necessary for a caller that did not,
  // such as the bootstrap path that creates an organisation. When the caller *is*
  // `asTenant`, asking again buys a round trip and nothing else, so it does not.
  const cached = tx.chain?.lockHeld === true ? tx.chain.head : undefined;
  if (tx.chain === undefined || !tx.chain.lockHeld) {
    await tx.client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.orgId]);
  }
  const prevHash =
    cached !== undefined && cached !== null && cached.org === input.orgId
      ? cached.hash
      : await chainHead(tx.client, input.orgId);

  const parts: HashableParts = {
    id,
    org: input.orgId,
    actor: input.actor,
    actorType: input.actorType,
    eventType: input.eventType,
    resource: input.resource ?? null,
    resourceId: input.resourceId ?? null,
    request: input.requestId ?? null,
    correlation: input.correlationId ?? null,
    policyVersion: input.policyVersionId ?? null,
    decision: input.decision ?? null,
    reasons: reasonCodes,
    severity,
    meta: metadata,
    prev: prevHash,
  };
  const hash = eventHash(parts);

  await tx.client.query(
    `INSERT INTO ari.audit_events
       (id, org_id, prev_hash, hash, actor, actor_type, event_type, resource, resource_id,
        request_id, correlation_id, policy_version_id, decision, reason_codes, metadata, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      input.orgId,
      prevHash,
      hash,
      input.actor,
      input.actorType,
      input.eventType,
      input.resource ?? null,
      input.resourceId ?? null,
      input.requestId ?? null,
      input.correlationId ?? null,
      input.policyVersionId ?? null,
      input.decision ?? null,
      reasonCodes,
      JSON.stringify(metadata),
      severity,
    ],
  );

  if (tx.chain !== undefined && tx.chain.lockHeld) {
    tx.chain.head = { org: input.orgId, hash };
  }

  return { ...input, metadata, reasonCodes, severity, id, prevHash, hash };
}

export /**
 * A row as read back, plus the columns Postgres assigned and the hash it claims.
 *
 * `seq` and `madeAt` are deliberately outside `HashableParts` and must stay there:
 * they are not in the digest, and hashing the whole row would make every
 * recomputation disagree with the writer's. That is not a theoretical concern — it
 * is the first thing this module got wrong.
 */
interface StoredEvent extends HashableParts {
  readonly seq: string;
  readonly madeAt: string;
  /** What the row claims. Compared against the recomputed value, never used as it. */
  readonly storedHash: string;
}

/** The projection that was hashed, and nothing else. */
function hashableOf(event: StoredEvent): HashableParts {
  const { seq: _seq, madeAt: _madeAt, storedHash: _storedHash, ...parts } = event;
  return parts;
}

async function readEvents(executor: AuditReader, orgId: string): Promise<StoredEvent[]> {
  const rows = await executor.query<{
    id: string;
    org_id: string;
    prev_hash: string;
    actor: string;
    actor_type: string;
    event_type: string;
    resource: string | null;
    resource_id: string | null;
    request_id: string | null;
    correlation_id: string | null;
    policy_version_id: string | null;
    decision: string | null;
    reason_codes: string[];
    metadata: SafeLogFields;
    hash: string;
    severity: string;
    seq: string;
    made_at: Date;
  }>(
    `SELECT id, org_id, prev_hash, hash, actor, actor_type, event_type, resource, resource_id,
            request_id, correlation_id, policy_version_id, decision, reason_codes, metadata,
            severity, seq, made_at
       FROM ari.audit_events WHERE org_id = $1 ORDER BY seq ASC`,
    [orgId],
  );

  return rows.rows.map((row) => ({
    seq: row.seq,
    madeAt: row.made_at.toISOString(),
    id: row.id,
    org: row.org_id,
    actor: row.actor,
    actorType: row.actor_type,
    eventType: row.event_type,
    resource: row.resource,
    resourceId: row.resource_id,
    request: row.request_id,
    correlation: row.correlation_id,
    policyVersion: row.policy_version_id,
    decision: row.decision,
    reasons: row.reason_codes,
    severity: row.severity,
    meta: row.metadata ?? {},
    prev: row.prev_hash,
    storedHash: row.hash,
  }));
}

export interface ChainReport {
  readonly ok: boolean;
  readonly events: number;
  /** `seq` values whose recomputed hash or chain link does not hold. */
  readonly breaks: readonly { readonly seq: string; readonly kind: 'HASH' | 'LINK' }[];
}

/**
 * Recompute the whole chain from what is stored.
 *
 * This is the check that runs on a schedule and on the CLI before anyone is shown
 * an audit view. It does not trust the `hash` column: the point is to notice when
 * the row's content and its claimed hash have parted company, which is what an
 * edit looks like from the outside.
 */
export async function verifyChain(
  executor: AuditReader,
  orgId: string,
): Promise<ChainReport> {
  const stored = await readEvents(executor, orgId);
  const breaks: { seq: string; kind: 'HASH' | 'LINK' }[] = [];
  let expectedPrev = GENESIS;

  for (const event of stored) {
    if (event.prev !== expectedPrev) breaks.push({ seq: event.seq, kind: 'LINK' });
    // One query read all the rows; this recomputes from them. Anything that still
    // touched the database here would be trusting the thing under examination.
    const recomputed = eventHash(hashableOf(event));
    if (recomputed !== event.storedHash) breaks.push({ seq: event.seq, kind: 'HASH' });
    expectedPrev = recomputed;
  }

  return { ok: breaks.length === 0, events: stored.length, breaks };
}
