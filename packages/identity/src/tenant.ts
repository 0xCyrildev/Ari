/**
 * The tenant boundary, as a type.
 *
 * T20 is the threat where a query in a hurry reads another organisation's rows.
 * `packages/identity` answers it twice: every repository function requires a
 * `TenantTx` it cannot be handed a bare client for, and Postgres row-security
 * policies (`migrations/004_identity.sql`) scope every read to the session's tenant
 * anyway. The first makes the mistake hard to write; the second makes it harmless
 * when someone writes it anyway.
 *
 * The tenant is set with `SET LOCAL`, inside the transaction that reads, so it
 * cannot outlive the unit of work it scopes — and a pooled connection that returns
 * to the pool carries nothing forward with it.
 */

import { beginTransaction, type LedgerTx } from '@ari/ledger';
import { newId } from '@ari/schemas';
import type { ChainCursor } from '@ari/audit';
import type { Pool, PoolClient } from 'pg';

export interface TenantTx extends LedgerTx {
  /** The tenant the session is scoped to, and the value row security filters on. */
  readonly orgId: string;
  /** The same handle under both contracts: one transaction, two capabilities. */
  /**
   * Wall clock, read once when the transaction opened.
   *
   * Supplied rather than called, for the same reason the policy engine takes
   * `nowMs` instead of reading a clock: two expiry checks inside one transaction
   * that disagree is a bug nobody can reproduce afterwards.
   */
  readonly startedAtMs: bigint;
  /**
   * The audit chain's position within this transaction. Present because the
   * organisation's advisory lock is taken as the transaction's first statement, which is
   * what lets `@ari/audit` remember the head it wrote instead of reading it back before
   * every event; typed here so the trust is declared rather than smuggled through a cast.
   */
  readonly chain: ChainCursor;
}

/** Anything that can open a connection, so a pool and a transaction are both fine. */
export type Connector = { connect(): Promise<PoolClient> };

/**
 * Run `fn` as one tenant, in one transaction.
 *
 * `orgId` is checked against the identifier format before it reaches `set_config`,
 * because a tenant key that is also the authorisation scope is not somewhere to be
 * permissive about what a caller can put in it.
 */
/** SQLSTATEs Postgres raises when the *schedule* lost, not the transaction's logic. */
const RETRYABLE = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

export async function asTenant<T>(pool: Connector, orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!/^org_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(orgId)) {
    throw new RangeError('asTenant requires an org_<uuidv7> identifier');
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runOnce(pool, orgId, fn);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      // Retried only when the database said this transaction lost a race it was
      // entitled to lose, and only a bounded number of times. Anything else — a
      // constraint, a policy refusal, a broken query — is a decision, not a
      // scheduling accident, and swallowing it would turn a real refusal into a
      // flaky test.
      if (!RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}

async function runOnce<T>(pool: Connector, orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return beginTransaction(pool, async (ledgerTx) => {
    const { client } = ledgerTx;
    // A parameter, not a splice: `SET LOCAL x = $1` is not valid SQL, so the only
    // safe form is set_config(), and the only safe value is one that has already
    // been checked against the format above.
    await client.query(`SELECT set_config('ari.org_id', $1, true)`, [orgId]);
    // The per-organisation chain lock, taken *first* — before any row this
    // transaction will touch. Taking it where the audit writer happens to sit is
    // what deadlocked it: one transaction holding a row lock and waiting for the
    // lock, another holding the lock and waiting for the row. Acquisition order is
    // the only thing that prevents that cycle, so it is fixed here rather than
    // left to each caller. Advisory transaction locks are re-entrant, so
    // `appendEvent` asking again is free.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [orgId]);
    // The lock is held from here to commit, so the audit writer inside this transaction
    // may take the chain's head on trust — its own last write — instead of reading it
    // back before every event. See `ChainCursor` in `@ari/audit`.
    const tx = Object.assign(ledgerTx, {
      orgId,
      startedAtMs: BigInt(Date.now()),
      chain: { lockHeld: true } as ChainCursor,
    }) as TenantTx;
    return fn(tx);
  });
}

/** A minted organisation id. Creation is the one operation with no tenant to scope by. */
export function newOrganizationId(): string {
  return newId('org');
}

/**
 * The scopes an agent credential can hold.
 *
 * A closed set, because `text[]` in the schema plus an unconstrained string in the
 * code is a vocabulary where `transaction:requests` and `transaction:request` are
 * different scopes and one of them is a hole.
 */
export const SCOPES = [
  'transaction:request',
  'transaction:read',
  'policy:read',
  'policy:activate',
  'approval:decide',
  'agent:manage',
  'wallet:manage',
  'audit:read',
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/**
 * The application's pool, for the paths that must run outside a tenant.
 *
 * Only one such path exists: authenticating a credential, where the tenant is not
 * yet known. It is exported as a `Connector` rather than a `Pool` so the callers
 * that need `connect()` cannot reach `query()` and skip the row policies by
 * accident.
 */
export type { Pool };
