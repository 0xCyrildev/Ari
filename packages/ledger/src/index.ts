/**
 * Limit accounting — the reservation half of Ari (CC3, ARCHITECTURE §9).
 *
 * This is the module the Phase 2 gate is really about. A policy engine that is
 * correct in isolation is still wrong: two `$4,000` requests against a `$5,000`
 * daily cap each evaluate independently, each see `$4,000` reserved, and each are
 * allowed. The fix is not a lock around evaluation, which would serialise the
 * whole system; it is that the limit check and the mutation that consumes it are
 * one statement, under a row lock, inside one transaction.
 *
 * Three things this file deliberately does *not* do:
 *   - It does not decide anything. `evaluate()` in @ari/policy-engine is the
 *     authority on whether a request is permitted; this module only records how
 *     much of a permitted amount has been set aside, and refuses when the money
 *     is not there.
 *   - It does not open or close transactions. The caller owns the transaction,
 *     because the reservation and the audit outbox have to commit together (S10)
 *     and that composition lives in `apps/api`.
 *   - It does not run under REPEATABLE READ. The idempotency path re-reads a row
 *     another transaction may have just committed, which needs the per-statement
 *     snapshot READ COMMITTED gives; on a repeatable-read transaction the retry
 *     says so loudly rather than returning the wrong hold.
 *
 * Amounts never cross the wire as `bigint`. Every one goes out as a decimal
 * string and comes back parsed, because the columns are `numeric` — a raw wei
 * total overflows int8 — and node-postgres stringifies unrecognised values by a
 * rule this module is not going to depend on.
 */

import { newId } from '@ari/schemas';
import type { Pool, PoolClient } from 'pg';

/** Anything that can run a query, so the read-side helpers work against a pool or a client alike. */
export type Executor = Pool | PoolClient;

export interface WindowKey {
  readonly orgId: string;
  readonly agentId: string;
  /** The bounded window this row accounts for, e.g. `2026-09-25` for a UTC day. */
  readonly windowKey: string;
  /** Which policy dimension this row bounds, e.g. `daily_raw`. */
  readonly dimension: string;
}

export interface ReserveInput extends WindowKey {
  readonly amountRaw: bigint;
  /** The cap in force, from the compiled policy version doing the authorising. */
  readonly maxRaw: bigint;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly policyVersionId: string;
}

export type ReservationResult =
  | { readonly status: 'HELD'; readonly reservationId: string; readonly reservedRaw: bigint }
  /** A retry of the same idempotency key. No second hold was taken. */
  | { readonly status: 'ALREADY_HELD'; readonly reservationId: string; readonly reservedRaw: bigint }
  | {
      readonly status: 'LIMIT_EXCEEDED';
      readonly reservedRaw: bigint;
      readonly requestedRaw: bigint;
      readonly maxRaw: bigint;
    };

export type ReleaseResult =
  | { readonly status: 'RELEASED'; readonly releasedRaw: bigint }
  | { readonly status: 'NOT_HELD' };

export type SettleResult =
  | { readonly status: 'SETTLED'; readonly settledRaw: bigint }
  | { readonly status: 'NOT_HELD' };

export interface CounterRow {
  readonly reservedRaw: bigint;
  readonly settledRaw: bigint;
  readonly settledRequests: number;
}

const TABLE_COUNTERS = 'ari.limit_counters';
const TABLE_RESERVATIONS = 'ari.reservations';

/**
 * A transaction this module opened, and the only thing `reserve` will accept.
 *
 * The handle is branded and constructed in exactly one place, because "reserve
 * inside a transaction" is a precondition the caller can otherwise get wrong in
 * silence: the counter update and the reservation row must commit together, or a
 * crash between them leaves capacity spent with nothing held against it. A
 * runtime assertion was the first attempt and it was worse than nothing — a
 * released `PoolClient` goes back into the pool and comes out carrying the marker
 * of a transaction that ended two requests ago.
 */
const OPEN: unique symbol = Symbol('ari.ledger.openTransaction');

export interface LedgerTx {
  readonly client: PoolClient;
  readonly [OPEN]: true;
}

/** Run `fn` in one transaction, committing on success and rolling back on any throw. */
export async function withTransaction<T>(
  pool: { connect(): Promise<PoolClient> },
  fn: (tx: LedgerTx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const tx: LedgerTx = { client, [OPEN]: true };
  await client.query('BEGIN');
  try {
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Take the row lock, creating the counter if this is the first request against
 * this window.
 *
 * The `INSERT … DO NOTHING` before the `SELECT … FOR UPDATE` is what makes the
 * first two concurrent requests serialise rather than deadlock: without it they
 * both try to insert the same primary key, one waits on the other's index
 * entry, and the loser of that race is the transaction that then has to decide
 * whether the cap still holds.
 */
async function lockCounter(client: PoolClient, key: WindowKey): Promise<bigint> {
  await client.query(
    `INSERT INTO ${TABLE_COUNTERS} (org_id, agent_id, window_key, dimension, current_reserved)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (org_id, agent_id, window_key, dimension) DO NOTHING`,
    [key.orgId, key.agentId, key.windowKey, key.dimension],
  );

  const locked = await client.query<{ current_reserved: string }>(
    `SELECT current_reserved FROM ${TABLE_COUNTERS}
      WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4
      FOR UPDATE`,
    [key.orgId, key.agentId, key.windowKey, key.dimension],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new Error(`counter row vanished while being locked for ${key.agentId}/${key.windowKey}`);
  }
  return BigInt(row.current_reserved);
}

/**
 * Atomically set aside `amountRaw` against the window's cap.
 *
 * The check and the increment are one statement on purpose. Two statements —
 * read, compare in JavaScript, write — are only correct under a lock that no
 * longer exists by the time the write lands, and that window is exactly where the
 * money goes.
 *
 * The ceiling that binds is `maxRaw` — the one the policy version doing this
 * authorisation carries — not a number read back out of the counter. Recording
 * which version applied, on the reservation row, is what keeps a downgrade from
 * silently re-binding money that was already committed under a looser limit (T7).
 */
export async function reserve(tx: LedgerTx, input: ReserveInput): Promise<ReservationResult> {
  const { client } = tx;
  const reservationId = newId('rsv');

  // Claim the idempotency key first. A retry then returns the hold it already
  // made instead of consuming capacity a second time, and a rolled-back attempt
  // leaves no claim behind to confuse the next one.
  const claimed = await client.query<{ id: string }>(
    `INSERT INTO ${TABLE_RESERVATIONS}
       (id, org_id, agent_id, request_id, idempotency_key, window_key, dimension,
        amount_raw, policy_version_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'HELD')
     ON CONFLICT (agent_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      reservationId,
      input.orgId,
      input.agentId,
      input.requestId,
      input.idempotencyKey,
      input.windowKey,
      input.dimension,
      input.amountRaw.toString(),
      input.policyVersionId,
    ],
  );

  if (claimed.rowCount === 0) {
    const existing = await client.query<{ id: string; amount_raw: string }>(
      `SELECT id, amount_raw FROM ${TABLE_RESERVATIONS}
        WHERE agent_id = $1 AND idempotency_key = $2`,
      [input.agentId, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error('idempotency claim exists but its reservation does not');
    return { status: 'ALREADY_HELD', reservationId: row.id, reservedRaw: BigInt(row.amount_raw) };
  }

  await lockCounter(client, input);

  const held = await client.query<{ current_reserved: string }>(
    `UPDATE ${TABLE_COUNTERS}
        SET current_reserved = current_reserved + $5
      WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4
        AND current_reserved + $5 <= $6
      RETURNING current_reserved`,
    [
      input.orgId,
      input.agentId,
      input.windowKey,
      input.dimension,
      input.amountRaw.toString(),
      input.maxRaw.toString(),
    ],
  );

  if (held.rowCount === 0) {
    const current = await client.query<{ current_reserved: string }>(
      `SELECT current_reserved FROM ${TABLE_COUNTERS}
        WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4`,
      [input.orgId, input.agentId, input.windowKey, input.dimension],
    );
    // Hand the idempotency claim back. A denial is not a spend: if the claim
    // survived, the key would report a hold that was never taken, and the caller
    // could not commit its audit row for the refusal in this same transaction.
    await client.query(`DELETE FROM ${TABLE_RESERVATIONS} WHERE id = $1`, [reservationId]);
    return {
      status: 'LIMIT_EXCEEDED',
      reservedRaw: BigInt(current.rows[0]?.current_reserved ?? '0'),
      requestedRaw: input.amountRaw,
      maxRaw: input.maxRaw,
    };
  }

  return { status: 'HELD', reservationId, reservedRaw: input.amountRaw };
}

/**
 * Give capacity back after a failure path — a lost signature, an expired ticket,
 * an abandoned request.
 *
 * Every branch that forgets to call this converts an attack into a self-inflicted
 * denial of service (T13, T23): the daily cap fills with reservations for
 * transactions that never happened, and the agent is locked out by its own
 * refused requests.
 */
export async function release(
  tx: LedgerTx,
  reservationId: string,
  reason: string,
): Promise<ReleaseResult> {
  const { client } = tx;
  const freed = await client.query<{
    amount_raw: string;
    org_id: string;
    agent_id: string;
    window_key: string;
    dimension: string;
  }>(
    `UPDATE ${TABLE_RESERVATIONS}
        SET status = 'RELEASED', resolved_at = now(), release_reason = $2
      WHERE id = $1 AND status = 'HELD'
      RETURNING amount_raw, org_id, agent_id, window_key, dimension`,
    [reservationId, reason],
  );

  const row = freed.rows[0];
  if (freed.rowCount === 0 || row === undefined) return { status: 'NOT_HELD' };

  await client.query(
    `UPDATE ${TABLE_COUNTERS}
        SET current_reserved = current_reserved - $5
      WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4`,
    [row.org_id, row.agent_id, row.window_key, row.dimension, row.amount_raw],
  );

  return { status: 'RELEASED', releasedRaw: BigInt(row.amount_raw) };
}

/** Move a hold into the settled totals once the transaction has actually signed. */
export async function settle(tx: LedgerTx, reservationId: string): Promise<SettleResult> {
  const { client } = tx;
  const moved = await client.query<{
    amount_raw: string;
    org_id: string;
    agent_id: string;
    window_key: string;
    dimension: string;
  }>(
    `UPDATE ${TABLE_RESERVATIONS}
        SET status = 'SETTLED', resolved_at = now()
      WHERE id = $1 AND status = 'HELD'
      RETURNING amount_raw, org_id, agent_id, window_key, dimension`,
    [reservationId],
  );

  const row = moved.rows[0];
  if (moved.rowCount === 0 || row === undefined) return { status: 'NOT_HELD' };

  await client.query(
    `UPDATE ${TABLE_COUNTERS}
        SET current_reserved = current_reserved - $5,
            settled = settled + $5,
            settled_requests = settled_requests + 1,
            reserved_requests = reserved_requests - 1
      WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4`,
    [row.org_id, row.agent_id, row.window_key, row.dimension, row.amount_raw],
  );

  return { status: 'SETTLED', settledRaw: BigInt(row.amount_raw) };
}

export async function readCounter(client: Executor, key: WindowKey): Promise<CounterRow | null> {
  const result = await client.query<{
    current_reserved: string;
    settled: string;
    settled_requests: string;
  }>(
    `SELECT current_reserved, settled, settled_requests FROM ${TABLE_COUNTERS}
      WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4`,
    [key.orgId, key.agentId, key.windowKey, key.dimension],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    reservedRaw: BigInt(row.current_reserved),
    settledRaw: BigInt(row.settled),
    settledRequests: Number(row.settled_requests),
  };
}

/**
 * Recompute the counter from the reservation ledger.
 *
 * Accounting that is only ever as correct as its own last update is not
 * accounting, so the two are derivable independently and compared: a drift means
 * something failed between a mutation and its bookkeeping, and the response is to
 * stop authorising, not to trust the larger number.
 */
export async function verifyCounterIntegrity(
  client: Executor,
  key: WindowKey,
): Promise<{ readonly ok: boolean; readonly counterRaw: bigint; readonly derivedRaw: bigint }> {
  const [counter, derived] = await Promise.all([
    readCounter(client, key),
    client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_raw), 0) AS total FROM ${TABLE_RESERVATIONS}
        WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4
          AND status = 'HELD'`,
      [key.orgId, key.agentId, key.windowKey, key.dimension],
    ),
  ]);
  const counterRaw = counter?.reservedRaw ?? 0n;
  const derivedRaw = BigInt(derived.rows[0]?.total ?? '0');
  return { ok: counterRaw === derivedRaw, counterRaw, derivedRaw };
}
