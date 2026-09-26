/**
 * The Phase 2 gate, on a real database.
 *
 * ROADMAP §"Standing risks": *"Phase 2's concurrency gate is the real filter.
 * Everything else in Phases 1–3 is well-trodden engineering. If the reservation
 * design is wrong, no amount of later polish makes Ari safe."*
 *
 * So this file does not mock Postgres, does not skip when Postgres is absent, and
 * does not assert the two-request example from the brief alone — it asserts the
 * example, then the general claim over randomised arrival orders, because the
 * specific case passes under almost any implementation and the general one does
 * not.
 */

import * as fc from 'fast-check';
import { newId } from '@ari/schemas';
import {
  readCounter,
  release,
  releaseForRequest,
  reserve,
  settle,
  verifyCounterIntegrity,
  withTransaction,
  type LedgerTx,
  type ReservationResult,
  type WindowKey,
} from '@ari/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTenant } from '@ari/identity';
import { connect } from './database.js';

let pool: Awaited<ReturnType<typeof connect>>;
let appPool: Awaited<ReturnType<typeof connect>>;

/**
 * The role `ari-api` actually holds the connection as.
 *
 * Everything above this block runs as `ari`, which owns these tables — and an owner is
 * outside both the grants and row security, so an entire class of bug is invisible to
 * it. That is not a hypothetical: the over-limit path deleted its idempotency claim,
 * `008` grants no DELETE on `reservations`, and every test in this file was green.
 *
 * The role is set at the connection, and the tenant at the transaction, exactly as the
 * service does it: `011` put these tables under row security, so an `ari_app`
 * connection with no `ari.org_id` is now a connection that can insert nothing and see
 * nothing. A test that skipped the scope would be asserting a failure mode production
 * cannot reach — which is why all five cases below go through `asTenant`.
 */
beforeAll(async () => {
  pool = await connect();
  appPool = await connect(4, 'ari_app');
});

afterAll(async () => {
  await appPool?.end();
  await pool?.end();
});

const DOLLAR = 1_000_000n;
const usd = (whole: bigint) => whole * DOLLAR;

/** A fresh tenant per case, so no test can borrow another's capacity. */
function fixture(): WindowKey {
  return {
    orgId: newId('org'),
    agentId: newId('agt'),
    windowKey: '2026-09-25',
    dimension: 'daily_raw',
  };
}

function held(results: ReservationResult[]): bigint {
  return results
    .filter((result): result is Extract<ReservationResult, { status: 'HELD' }> => result.status === 'HELD')
    .reduce((total, result) => total + result.reservedRaw, 0n);
}

/**
 * One transaction as `ari-api` would open it: the application role, holding this
 * tenant's scope. `asTenant` is the product's own helper, so this is not a test
 * shape — it is the only shape that can write these tables at all.
 */
function asApp<T>(key: WindowKey, fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
  return asTenant(appPool, key.orgId, fn);
}

describe('the brief’s own example', () => {
  it('admits exactly one of two $4,000 requests against a $5,000 daily cap', async () => {
    const key = fixture();
    const cap = usd(5_000n);
    const request = (n: number) =>
      withTransaction(pool, (tx) =>
        reserve(tx, {
          ...key,
          amountRaw: usd(4_000n),
          maxRaw: cap,
          requestId: newId('req'),
          idempotencyKey: `batch-${n}`,
          policyVersionId: newId('ppv'),
        }),
      );

    const results = await Promise.all([request(1), request(2)]);
    expect(results.map((result) => result.status).sort()).toEqual(['HELD', 'LIMIT_EXCEEDED']);
    expect(held(results)).toBe(usd(4_000n));

    const counter = await readCounter(pool, key);
    expect(counter?.reservedRaw).toBe(usd(4_000n));
  });

  it('reports the refusal in terms the caller can act on', async () => {
    const key = fixture();
    const cap = usd(5_000n);
    await withTransaction(pool, (tx) => reserve(tx, { ...key, amountRaw: usd(4_000n), maxRaw: cap, requestId: newId('req'), idempotencyKey: 'first', policyVersionId: newId('ppv') }));

    const second = await withTransaction(pool, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(2_000n), maxRaw: cap, requestId: newId('req'), idempotencyKey: 'second', policyVersionId: newId('ppv') }),
    );
    if (second.status !== 'LIMIT_EXCEEDED') throw new Error('expected the second request to be refused');
    expect(second.reservedRaw).toBe(usd(4_000n));
    expect(second.requestedRaw).toBe(usd(2_000n));
    expect(second.maxRaw).toBe(cap);
  });
});

describe('the general claim, over randomised arrival orders', () => {
  it('never admits more than the cap, whatever the schedule', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: usd(1_000n) }), { minLength: 8, maxLength: 20 }),
        async (amounts) => {
          const key = fixture();
          const cap = usd(5_000n);
          const results = await Promise.all(
            amounts.map((amountRaw, index) =>
              withTransaction(pool, (tx) =>
                reserve(tx, {
                  ...key,
                  amountRaw,
                  maxRaw: cap,
                  requestId: newId('req'),
                  idempotencyKey: `req-${index}`,
                  policyVersionId: newId('ppv'),
                }),
              ),
            ),
          );

          // Safety: the accepted total never exceeds the cap, however the
          // transactions interleaved.
          expect(held(results) <= cap).toBe(true);

          // Liveness: a refusal is never handed back capacity that was free at the
          // moment of refusal. `reservedRaw` is read inside the same transaction,
          // under the row lock, so this is the value that actually bound it.
          for (const result of results) {
            if (result.status === 'LIMIT_EXCEEDED') {
              expect(result.reservedRaw + result.requestedRaw > cap).toBe(true);
            }
          }

          // The counter still agrees with the ledger it is supposed to summarise.
          expect((await verifyCounterIntegrity(pool, key)).ok).toBe(true);
        },
      ),
      { numRuns: 8 },
    );
    // Real transactions against real Postgres, so the run gets past the default
    // five seconds rather than trading the property for a timeout.
  }, 180_000);
});

describe('idempotency', () => {
  it('turns a retry into the same hold, not a second one', async () => {
    const key = fixture();
    const cap = usd(5_000n);
    const args = {
      ...key,
      amountRaw: usd(1_000n),
      maxRaw: cap,
      requestId: newId('req'),
      idempotencyKey: 'same-call-twice',
      policyVersionId: newId('ppv'),
    };

    const first = await withTransaction(pool, (tx) => reserve(tx, args));
    const second = await withTransaction(pool, (tx) => reserve(tx, args));

    if (first.status !== 'HELD' || second.status !== 'ALREADY_HELD') {
      throw new Error(`expected HELD then ALREADY_HELD, got ${first.status} then ${second.status}`);
    }
    expect(second.reservationId).toBe(first.reservationId);
    expect((await readCounter(pool, key))?.reservedRaw).toBe(usd(1_000n));
  });

  it('admits one hold when the same idempotency key races itself', async () => {
    const key = fixture();
    const args = {
      ...key,
      amountRaw: usd(1_000n),
      maxRaw: usd(5_000n),
      requestId: newId('req'),
      idempotencyKey: 'double-submit',
      policyVersionId: newId('ppv'),
    };
    const results = await Promise.all([
      withTransaction(pool, (tx) => reserve(tx, args)),
      withTransaction(pool, (tx) => reserve(tx, args)),
      withTransaction(pool, (tx) => reserve(tx, args)),
    ]);
    expect(held(results)).toBe(usd(1_000n));
    expect(results.filter((result) => result.status === 'ALREADY_HELD')).toHaveLength(2);
  });

  it('leaves nothing behind when the surrounding transaction rolls back', async () => {
    const key = fixture();
    const args = {
      ...key,
      amountRaw: usd(1_000n),
      maxRaw: usd(5_000n),
      requestId: newId('req'),
      idempotencyKey: 'rolled-back',
      policyVersionId: newId('ppv'),
    };

    await expect(
      withTransaction(pool, async (tx) => {
        await reserve(tx, args);
        throw new Error('the audit writer failed after the hold');
      }),
    ).rejects.toThrow('audit writer');

    expect((await readCounter(pool, key))?.reservedRaw ?? 0n).toBe(0n);
    // The claim went back with the transaction, so the same key is usable again
    // rather than permanently reporting a hold that never committed.
    const retry = await withTransaction(pool, (tx) => reserve(tx, args));
    expect(retry.status).toBe('HELD');
  });
});

describe('releasing capacity', () => {
  it('gives the room back exactly once', async () => {
    const key = fixture();
    const cap = usd(5_000n);
    const reservationId = await withTransaction(pool, async (tx) => {
      const result = await reserve(tx, {
        ...key,
        amountRaw: usd(5_000n),
        maxRaw: cap,
        requestId: newId('req'),
        idempotencyKey: 'to-release',
        policyVersionId: newId('ppv'),
      });
      if (result.status !== 'HELD') throw new Error('expected the hold to succeed');
      return result.reservationId;
    });

    expect((await readCounter(pool, key))?.reservedRaw).toBe(cap);
    const denied = await withTransaction(pool, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(1n), maxRaw: cap, requestId: newId('req'), idempotencyKey: 'while-full', policyVersionId: newId('ppv') }),
    );
    expect(denied.status).toBe('LIMIT_EXCEEDED');

    const released = await withTransaction(pool, (tx) => release(tx, reservationId, 'TICKET_EXPIRED'));
    expect(released.status).toBe('RELEASED');
    expect((await readCounter(pool, key))?.reservedRaw).toBe(0n);

    const replayed = await withTransaction(pool, (tx) => release(tx, reservationId, 'TICKET_EXPIRED'));
    expect(replayed.status).toBe('NOT_HELD');
    expect((await readCounter(pool, key))?.reservedRaw).toBe(0n);

    const fits = await withTransaction(pool, (tx) =>
      reserve(tx, { ...key, amountRaw: cap, maxRaw: cap, requestId: newId('req'), idempotencyKey: 'after-release', policyVersionId: newId('ppv') }),
    );
    expect(fits.status).toBe('HELD');
  });

  it('refuses to release a hold that was already settled', async () => {
    const key = fixture();
    const id = await withTransaction(pool, async (tx) => {
      const result = await reserve(tx, {
        ...key,
        amountRaw: usd(2_000n),
        maxRaw: usd(5_000n),
        requestId: newId('req'),
        idempotencyKey: 'settle-then-release',
        policyVersionId: newId('ppv'),
      });
      if (result.status !== 'HELD') throw new Error('expected the hold to succeed');
      return result.reservationId;
    });

    const settled = await withTransaction(pool, (tx) => settle(tx, id));
    expect(settled.status).toBe('SETTLED');
    const counter = await readCounter(pool, key);
    expect(counter?.reservedRaw).toBe(0n);
    expect(counter?.settledRaw).toBe(usd(2_000n));
    expect(counter?.settledRequests).toBe(1);

    expect((await withTransaction(pool, (tx) => release(tx, id, 'SIGNING_FAILED'))).status).toBe('NOT_HELD');
    // Settled money does not come back: the spend happened, and releasing it would
    // hand the agent a second budget for a transaction that already paid out.
    expect((await readCounter(pool, key))?.settledRaw).toBe(usd(2_000n));
  });
});

describe('the boundaries the design has to hold at', () => {
  it('keeps one agent’s capacity invisible to another, and across organisations', async () => {
    const a = fixture();
    const b = fixture();
    const cap = usd(1_000n);
    const first = await withTransaction(pool, (tx) =>
      reserve(tx, { ...a, amountRaw: cap, maxRaw: cap, requestId: newId('req'), idempotencyKey: 'a-only', policyVersionId: newId('ppv') }),
    );
    expect(first.status).toBe('HELD');

    const otherAgent = await withTransaction(pool, (tx) =>
      reserve(tx, { ...b, amountRaw: cap, maxRaw: cap, requestId: newId('req'), idempotencyKey: 'b-too', policyVersionId: newId('ppv') }),
    );
    expect(otherAgent.status).toBe('HELD');
    expect((await readCounter(pool, a))?.reservedRaw).toBe(cap);
    expect((await readCounter(pool, b))?.reservedRaw).toBe(cap);
  });

  it('counts amounts a bigint column could not hold', async () => {
    // 10^30 raw units is past 2^63 and past what a JSON number could carry. The
    // columns are numeric for this reason, and if they were ever changed to int8
    // this test is where the silent truncation would surface.
    const key = fixture();
    const huge = 10n ** 30n;
    const result = await withTransaction(pool, (tx) =>
      reserve(tx, { ...key, amountRaw: huge, maxRaw: huge * 2n, requestId: newId('req'), idempotencyKey: 'wei-scale', policyVersionId: newId('ppv') }),
    );
    expect(result.status).toBe('HELD');
    const counter = await readCounter(pool, key);
    expect(counter?.reservedRaw).toBe(huge);
    expect((await verifyCounterIntegrity(pool, key)).ok).toBe(true);
  });

  it('detects a counter that has drifted from the ledger it summarises', async () => {
    const key = fixture();
    await withTransaction(pool, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(1n), maxRaw: usd(5_000n), requestId: newId('req'), idempotencyKey: 'drift', policyVersionId: newId('ppv') }),
    );
    await pool.query(
      `UPDATE ari.limit_counters SET current_reserved = current_reserved + 100
        WHERE org_id = $1 AND agent_id = $2 AND window_key = $3 AND dimension = $4`,
      [key.orgId, key.agentId, key.windowKey, key.dimension],
    );
    const integrity = await verifyCounterIntegrity(pool, key);
    expect(integrity.ok).toBe(false);
    expect(integrity.counterRaw - integrity.derivedRaw).toBe(100n);
  });

  it('mints its transaction handle in one place, so a bare client cannot reserve', () => {
    // @ts-expect-error — a Pool is not a LedgerTx; only withTransaction opens one.
    const wrong: LedgerTx = pool;
    // The compile error above is the assertion. This keeps the binding live so tsc
    // cannot elide it, and it cuts both ways: if `reserve` is ever widened to
    // accept a raw client, the now-redundant suppression above becomes the error.
    expect(wrong).toBeDefined();
  });
});


describe('the role the service actually runs as', () => {
  it('refuses an over-cap request as a refusal, not as a permission error', async () => {
    const key = fixture();
    const cap = usd(5_000n);
    await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(4_000n), maxRaw: cap, requestId: newId('txr'), idempotencyKey: 'a-1', policyVersionId: newId('ppv') }),
    );

    // Before the status machine, this statement threw
    // `permission denied for table reservations`: the claim row was inserted as HELD and
    // deleted when the cap refused it, and `ari_app` may not delete. The refusal is a
    // value the pipeline audits, so a 500 here is a refusal that never got recorded.
    const second = await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(2_000n), maxRaw: cap, requestId: newId('txr'), idempotencyKey: 'a-2', policyVersionId: newId('ppv') }),
    );
    expect(second.status).toBe('LIMIT_EXCEEDED');
  });

  it('leaves the refused attempt as a row, because this role cannot delete one', async () => {
    const key = fixture();
    const cap = usd(1_000n);
    const refused = await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(2_000n), maxRaw: cap, requestId: newId('txr'), idempotencyKey: 'abandon-me', policyVersionId: newId('ppv') }),
    );
    expect(refused.status).toBe('LIMIT_EXCEEDED');

    // Read back as this role, inside its own tenant scope, rather than as the table
    // owner: the claim is that the row *survives*, and row security is now part of the
    // story — an unscoped read would return zero rows and look identical to the row
    // having been deleted.
    const rows = await asApp(key, (tx) =>
      tx.client.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text FROM ari.reservations WHERE agent_id = $1 AND idempotency_key = $2 AND dimension = $3 GROUP BY status`,
        [key.agentId, 'abandon-me', key.dimension],
      ),
    );
    expect(rows.rows.map((row) => `${row.status}:${row.count}`)).toEqual(['ABANDONED:1']);
    // Abandoned is not a spend, and the window must not have moved.
    expect((await readCounter(pool, key))?.reservedRaw).toBe(0n);
  });

  it('reclaims a dead claim instead of leaving the key parked forever', async () => {
    const key = fixture();
    const tooBig = usd(2_000n);
    const cap = usd(1_000n);
    const first = await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: tooBig, maxRaw: cap, requestId: newId('txr'), idempotencyKey: 'retry-key', policyVersionId: newId('ppv') }),
    );
    expect(first.status).toBe('LIMIT_EXCEEDED');

    // Same key, smaller amount, after the cap had refused it. The claim exists and is
    // dead; the attempt is allowed to live.
    const again = await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(600n), maxRaw: cap, requestId: newId('txr'), idempotencyKey: 'retry-key', policyVersionId: newId('ppv') }),
    );
    expect(again.status).toBe('HELD');
    expect((await readCounter(pool, key))?.reservedRaw).toBe(usd(600n));
  });

  it('still counts money that has settled against the window it was spent in', async () => {
    // The money bug this test is the record of. Settling moves an amount out of
    // `current_reserved` and into `settled`, and the cap guard compared only the first —
    // so five $1,000 payments against a $5,000 daily ceiling, each settling before the
    // next was asked for, never touched the ceiling. It was latent only because nothing
    // called `settle` yet; the delivery step does now.
    const key = fixture();
    const cap = usd(2_000n);
    const held = await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(2_000n), maxRaw: cap, requestId: newId('txr'), idempotencyKey: 'paid', policyVersionId: newId('ppv') }),
    );
    if (held.status !== 'HELD') throw new Error('expected the first hold');
    await asApp(key, (tx) => settle(tx, held.reservationId));

    expect((await readCounter(pool, key))?.reservedRaw).toBe(0n);
    expect((await readCounter(pool, key))?.settledRaw).toBe(usd(2_000n));

    const next = await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(1n), maxRaw: cap, requestId: newId('txr'), idempotencyKey: 'after-settle', policyVersionId: newId('ppv') }),
    );
    expect(next.status).toBe('LIMIT_EXCEEDED');
    if (next.status !== 'LIMIT_EXCEEDED') return;
    // The number the refusal reports is the number that bound: what left the account,
    // not what is parked.
    expect(next.reservedRaw).toBe(usd(2_000n));
  });

  it('holds one request against a day and a month as two claims', async () => {
    const key = fixture();
    const month: WindowKey = { ...key, windowKey: '2026-09', dimension: 'monthly_raw' };
    const daily = await asApp(key, (tx) =>
      reserve(tx, { ...key, amountRaw: usd(500n), maxRaw: usd(1_000n), requestId: 'txr_shared', idempotencyKey: 'two-windows', policyVersionId: newId('ppv') }),
    );
    const monthly = await asApp(month, (tx) =>
      reserve(tx, { ...month, amountRaw: usd(500n), maxRaw: usd(20_000n), requestId: 'txr_shared', idempotencyKey: 'two-windows', policyVersionId: newId('ppv') }),
    );

    expect(daily.status).toBe('HELD');
    expect(monthly.status).toBe('HELD');
    if (daily.status !== 'HELD' || monthly.status !== 'HELD') return;
    // The point of the `(agent, key, dimension)` key: one idempotency claim per window,
    // not one per request, so a monthly limit can exist at all.
    expect(daily.reservationId).not.toBe(monthly.reservationId);

    const released = await asApp(key, (tx) => releaseForRequest(tx, key.orgId, 'txr_shared', 'test'));
    expect(released.rows).toBe(2);
    expect(released.releasedRaw).toBe(usd(1_000n));
    expect((await readCounter(pool, key))?.reservedRaw).toBe(0n);
    expect((await readCounter(pool, month))?.reservedRaw).toBe(0n);
  });
});
