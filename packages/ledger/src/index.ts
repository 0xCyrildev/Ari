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
 * The reservation statuses that a new claim may be taken from.
 *
 * `012`'s trigger permits exactly these, and no others: `HELD` is somebody's live
 * reservation, `SETTLED` is money that left, and neither is a starting point.
 */
const RECLAIMABLE = new Set(['PENDING', 'ABANDONED', 'RELEASED']);

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

/**
 * Open a transaction and hand out the one handle that can spend reservations.
 *
 * This is exported because `@ari/identity` builds its tenant handle on top of it.
 * Two packages each branding their own handle over the same Postgres transaction is
 * what made the pipeline unwritable: a reservation and the audit row that witnesses
 * it have to be in one transaction, and a caller holding two incompatible handles
 * can only put them in two, which is exactly the window where a decision is
 * committed and its evidence is not.
 */
export async function beginTransaction<T>(
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

/** Run `fn` in one transaction, committing on success and rolling back on any throw. */
export async function withTransaction<T>(
  pool: { connect(): Promise<PoolClient> },
  fn: (tx: LedgerTx) => Promise<T>,
): Promise<T> {
  return beginTransaction(pool, fn);
}

/**
 * Make sure a counter row exists for this window, so the guarded update below has
 * something to lock.
 *
 * The `INSERT … DO NOTHING` is what makes the first two concurrent requests serialise
 * rather than deadlock: without it they both try to insert the same primary key, one
 * waits on the other's index entry, and the loser of that race is the transaction that
 * then has to decide whether the cap still holds.
 *
 * It does not also `SELECT … FOR UPDATE`. That read used to sit here, and it bought a
 * round trip on every single reservation to take a lock the very next statement takes
 * anyway: an `UPDATE` on a row another transaction is writing blocks until that one
 * commits, and under READ COMMITTED it then re-reads the *committed* value and
 * re-evaluates its own `WHERE`. The check-and-mutate is one statement, and one lock.
 */
async function ensureCounter(client: PoolClient, key: WindowKey): Promise<void> {
  await client.query(
    `INSERT INTO ${TABLE_COUNTERS} (org_id, agent_id, window_key, dimension, current_reserved)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (org_id, agent_id, window_key, dimension) DO NOTHING`,
    [key.orgId, key.agentId, key.windowKey, key.dimension],
  );
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

  // Claim the idempotency key first, and claim it `PENDING`.
  //
  // The claim and the capacity are two different facts and they need to survive
  // separately. This used to insert the row as `HELD` and `DELETE` it when the cap
  // refused — and `008` gives `ari_app` no DELETE on this table, on purpose ("a role
  // that could remove a row could remove the evidence"), so the over-limit race threw
  // `permission denied` instead of returning a refusal: a 500, a rolled-back audit row,
  // and no `LIMIT_RESERVATION_FAILED` for a refusal that did happen.
  const claimSql = `
    INSERT INTO ${TABLE_RESERVATIONS}
      (id, org_id, agent_id, request_id, idempotency_key, window_key, dimension,
       amount_raw, policy_version_id, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING')
    ON CONFLICT (agent_id, idempotency_key, dimension) DO NOTHING
    RETURNING id`;

  let holdId = (await client.query<{ id: string }>(claimSql, [
    newId('rsv'),
    input.orgId,
    input.agentId,
    input.requestId,
    input.idempotencyKey,
    input.windowKey,
    input.dimension,
    input.amountRaw.toString(),
    input.policyVersionId,
  ])).rows[0]?.id;

  if (holdId === undefined) {
    const existing = await client.query<{ id: string; status: string; amount_raw: string }>(
      // The tenant predicate is written even though `agent_id` is a globally unique
      // uuidv7 and row security already filters this statement for `ari_app`: the
      // alternative is that re-claiming another tenant's idempotency key rests on two
      // things being true at once — the id generator, and the connection not being one
      // that bypasses policies. Both are invisible at the point where someone changes
      // either of them.
      `SELECT id, status, amount_raw FROM ${TABLE_RESERVATIONS}
        WHERE org_id = $1 AND agent_id = $2 AND idempotency_key = $3 AND dimension = $4
        FOR UPDATE`,
      [input.orgId, input.agentId, input.idempotencyKey, input.dimension],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error('idempotency claim exists but its reservation does not');
    if (row.status === 'HELD' || row.status === 'SETTLED') {
      return { status: 'ALREADY_HELD', reservationId: row.id, reservedRaw: BigInt(row.amount_raw) };
    }
    // A dead claim — `ABANDONED` by an attempt the cap refused, `RELEASED` by a signature
    // that never landed, or `PENDING` left by a transaction that died between claim and
    // capacity — is re-claimed rather than duplicated. The unique key is the request's
    // identity, so there is exactly one row per (key, dimension) and the history of an
    // attempt that failed twice stays one row.
    //
    // Listed rather than inferred from "not one of the live ones", and `012` is its
    // mirror image: the trigger permits exactly these three backwards steps. An unknown
    // status arriving here is a schema change nobody reconciled, and silently re-claiming
    // it is how a fourth state becomes spendable money.
    if (!RECLAIMABLE.has(row.status)) {
      throw new Error(`reservation ${row.id} holds status ${row.status}, which is neither live nor re-claimable`);
    }
    await client.query(
      `UPDATE ${TABLE_RESERVATIONS}
          SET status = 'PENDING', amount_raw = $2, request_id = $3, policy_version_id = $4,
              window_key = $5, resolved_at = NULL, release_reason = NULL
        WHERE id = $1`,
      [row.id, input.amountRaw.toString(), input.requestId, input.policyVersionId, input.windowKey],
    );
    holdId = row.id;
  }

  await ensureCounter(client, input);

  // The check and the increment are one statement on purpose, and the number it checks
  // against is `current_reserved + settled`.
  //
  // Settled money leaves `current_reserved` when a hold is settled, so a daily cap
  // checked against outstanding holds alone resets itself every time a payment
  // completes: five $1,000 payments against a $5,000 ceiling, each settling before the
  // next is asked for, and the ceiling never binding once. A limit is a promise about
  // what left the account in this window, not about what is currently parked.
  const held = await client.query<{ current_reserved: string }>(
    `UPDATE ${TABLE_COUNTERS}
        SET current_reserved = current_reserved + $5,
            reserved_requests = reserved_requests + 1
      WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4
        AND current_reserved + settled + $5 <= $6
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
    const current = await client.query<{ current_reserved: string; settled: string }>(
      `SELECT current_reserved, settled FROM ${TABLE_COUNTERS}
        WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4`,
      [input.orgId, input.agentId, input.windowKey, input.dimension],
    );
    const counter = current.rows[0];
    const committed = BigInt(counter?.current_reserved ?? '0') + BigInt(counter?.settled ?? '0');
    // The claim goes to `ABANDONED` rather than away. It is not a spend and nothing
    // downstream may read it as one — the counter was not touched — but it is a record
    // that this key was tried, which is what a reconciliation pass needs to see.
    await client.query(
      `UPDATE ${TABLE_RESERVATIONS} SET status = 'ABANDONED', resolved_at = now() WHERE id = $1`,
      [holdId],
    );
    return {
      status: 'LIMIT_EXCEEDED',
      // `reservedRaw` here is everything already committed against the window: the
      // outstanding holds *and* the settled total. The refusal message an operator reads
      // has to add up to the same number the guard compared.
      reservedRaw: committed,
      requestedRaw: input.amountRaw,
      maxRaw: input.maxRaw,
    };
  }

  await client.query(`UPDATE ${TABLE_RESERVATIONS} SET status = 'HELD' WHERE id = $1`, [holdId]);
  return { status: 'HELD', reservationId: holdId, reservedRaw: input.amountRaw };
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

/**
 * Every hold this request has outstanding — one per window it is bounded by, so a
 * policy with both a daily and a monthly ceiling produces two rows for one payment.
 *
 * The delivery step works in request ids rather than reservation ids because the
 * decision plane hands a `requestId` to the edge and does not hand it a list of holds:
 * a capability-shaped identifier for something outside the transaction is exactly the
 * thing this boundary keeps from the caller.
 */
async function heldForRequest(
  client: PoolClient,
  orgId: string,
  requestId: string,
): Promise<readonly string[]> {
  // `request_id` is a uuidv7 and globally unique, and `release`/`settle` still CAS on
  // `status = 'HELD'` per row, so a missing tenant predicate here could not move another
  // tenant's money today. It is written anyway because the alternative is that the safety
  // of a funds-moving statement rests on a uniqueness argument nobody re-states when the
  // id generation changes.
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM ${TABLE_RESERVATIONS}
      WHERE org_id = $1 AND request_id = $2 AND status = 'HELD' ORDER BY dimension`,
    [orgId, requestId],
  );
  return rows.rows.map((row) => row.id);
}

/** Settle every hold a request took. Returns the raw total moved, and the rows it moved. */
export async function settleForRequest(
  tx: LedgerTx,
  orgId: string,
  requestId: string,
): Promise<{ readonly settledRaw: bigint; readonly rows: number }> {
  const ids = await heldForRequest(tx.client, orgId, requestId);
  let total = 0n;
  for (const id of ids) {
    const settled = await settle(tx, id);
    if (settled.status === 'SETTLED') total += settled.settledRaw;
  }
  return { settledRaw: total, rows: ids.length };
}

/** Give back every hold a request took, when the request can no longer be honoured. */
export async function releaseForRequest(
  tx: LedgerTx,
  orgId: string,
  requestId: string,
  reason: string,
): Promise<{ readonly releasedRaw: bigint; readonly rows: number }> {
  const ids = await heldForRequest(tx.client, orgId, requestId);
  let total = 0n;
  for (const id of ids) {
    const released = await release(tx, id, reason);
    if (released.status === 'RELEASED') total += released.releasedRaw;
  }
  return { releasedRaw: total, rows: ids.length };
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

export {
  claimTicket,
  mintTicket,
  recordDecision,
  type DecisionOutcome,
  type ChainArtifact,
  type DecisionRecord,
  type TicketRow,
} from './decisions.js';
export { inspectDatabaseUrl, probeDatabase, tlsVerdict, HEALTH_PROBE_TIMEOUT_MS, type DatabaseTls, type DatabaseUrlFacts, type TlsObservation } from './connection.js';
