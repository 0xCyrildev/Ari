/**
 * The schema's own claim, checked against the schema.
 *
 * Every other file in this directory proves one behaviour: a trigger that refuses,
 * a grant that stops, a policy that filters. None of them proves the *shape* — that
 * every table holding a tenant's rows is actually under row security, because a
 * missing policy is invisible to any test that never queries that table. `011` is
 * what found this: the money tables had carried an `org_id` convention for eight
 * migrations, and nothing noticed that the convention had no enforcement under it.
 *
 * So this file asks the catalogue, not the code. It fails on the day somebody adds
 * `ari.payees` or `ari.settlements` and forgets the two policies, which is the day
 * the isolation guarantee stops being true and starts being a habit.
 */

import { appendEvent } from '@ari/audit';
import { newId } from '@ari/schemas';
import { recordDecision, reserve, withTransaction, type LedgerTx } from '@ari/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './database.js';

let pool: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  pool = await connect();
});

afterAll(async () => {
  await pool?.end();
});

/** The GUC every policy filters on, and that `asTenant` is the only thing permitted to set. */
const TENANT_SETTING = `current_setting('ari.org_id'`;

interface Table {
  readonly table: string;
  readonly rowSecurity: boolean;
  readonly hasOrgColumn: boolean;
}

interface Policy {
  readonly table: string;
  readonly name: string;
  readonly command: string;
  readonly usingExpr: string;
  readonly checkExpr: string;
}

const TABLES_SQL = `
  SELECT c.relname::text             AS "table",
         c.relrowsecurity            AS "rowSecurity",
         EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid
                    AND a.attname = 'org_id'
                    AND a.attnum > 0
                    AND NOT a.attisdropped) AS "hasOrgColumn"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'ari' AND c.relkind = 'r'
   ORDER BY 1
`;

const POLICIES_SQL = `
  SELECT tablename::text          AS "table",
         policyname::text         AS "name",
         cmd::text                AS "command",
         COALESCE(qual, '')       AS "usingExpr",
         COALESCE(with_check, '') AS "checkExpr"
    FROM pg_policies
   WHERE schemaname = 'ari'
   ORDER BY 1, 2
`;

async function tables(): Promise<Table[]> {
  return (await pool.query<Table>(TABLES_SQL)).rows;
}

async function policies(): Promise<Policy[]> {
  return (await pool.query<Policy>(POLICIES_SQL)).rows;
}

/** The tables row security is enabled on — what the predicate test below is about. */
function secured(rows: readonly Table[]): string[] {
  return rows.filter((row) => row.rowSecurity).map((row) => row.table);
}

describe('row security covers every tenant-bearing table', () => {
  it('with exactly the exceptions this file names', async () => {
    const rows = await tables();
    expect(rows.length).toBeGreaterThan(0);

    // `signing_tickets` is the one tenant-owned table deliberately outside row
    // security, and the reason is in `011`: `ari-signer` is a single process that
    // legitimately redeems tickets for every tenant and has no tenant scope to set,
    // so a policy there would not be a hole — it would be a silent no-op on every
    // claim. What bounds it instead is the row itself: `claimTicket` needs the sealed
    // digest and an unredeemed status.
    //
    // Naming the exception here, rather than tolerating any unscoped table, is the
    // point. A second entry in this list is a decision about the authority plane, and
    // it should be argued in a migration and here — not arrived at by omission.
    const unscoped = rows.filter((row) => row.hasOrgColumn && !row.rowSecurity).map((row) => row.table);
    expect(unscoped).toEqual(['signing_tickets']);
  });

  it('and every policy that exists scopes to the tenant setting', async () => {
    const scoped = secured(await tables());
    expect(scoped.length).toBeGreaterThan(0);
    const all = await policies();

    // Coverage first: a table with row security enabled and no policy of its own is
    // fail-closed rather than open, but it is also a table nothing can read, which is
    // an outage waiting for the first query to arrive. So the shape is required, not
    // inferred from the absence of a hole.
    const missingRead = scoped.filter(
      (table) =>
        !all.some(
          (p) =>
            p.table === table &&
            (p.command === 'ALL' || p.command === 'SELECT') &&
            p.usingExpr.includes(TENANT_SETTING),
        ),
    );
    expect(missingRead).toEqual([]);

    const missingWrite = scoped.filter(
      (table) =>
        !all.some(
          (p) =>
            p.table === table && (p.command === 'ALL' || p.command === 'INSERT') && p.checkExpr.includes(TENANT_SETTING),
        ),
    );
    expect(missingWrite).toEqual([]);

    // Then the hole itself, which the two checks above cannot see. Row security is
    // permissive by default: policies on one table are OR-ed, so a single
    // `USING (true)` beside a correct `tenant_isolation` makes the table wide open
    // while every scoping policy still exists and still reads as coverage in a diff.
    // So the rule is about every policy, not about there being one good policy.
    const unscopedPredicate = all
      .filter((p) => scoped.includes(p.table))
      .filter(
        (p) =>
          (p.usingExpr !== '' && !p.usingExpr.includes(TENANT_SETTING)) ||
          (p.checkExpr !== '' && !p.checkExpr.includes(TENANT_SETTING)),
      )
      .map((p) => `${p.table}.${p.name}`);
    expect(unscopedPredicate).toEqual([]);

    // UPDATE and DELETE are the commands that get forgotten, and they are the ones a
    // stolen credential reaches for. Postgres applies an `ALL` policy's `USING` to
    // them, which is why `tenant_isolation` is written `FOR ALL`: a caller that
    // guesses another tenant's row id must still be unable to match it. Asserted
    // separately because that inheritance is a rule about the planner, and it stops
    // holding the moment somebody adds a narrower `FOR SELECT` policy beside it.
    const missingUpdate = scoped.filter(
      (table) =>
        !all.some(
          (p) =>
            p.table === table &&
            (p.command === 'ALL' || p.command === 'UPDATE') &&
            p.usingExpr.includes(TENANT_SETTING),
        ),
    );
    expect(missingUpdate).toEqual([]);
  });
});

describe('an unscoped connection sees nothing, not everything', () => {
  /**
   * One row, for a tenant of its own, in each of three tables chosen for what their
   * exposure would mean: money parked, money spent, and the record of who decided
   * what. Written as the table owner, because the subject here is the read policy and
   * an owner is outside it — and because a fixture that had to pass through the
   * policies it is testing could not tell a missing row from a refused one.
   */
  const cases: readonly { readonly table: string; readonly orgId: string; readonly write: (tx: LedgerTx) => Promise<unknown> }[] = [
    (() => {
      const orgId = newId('org');
      const agentId = newId('agt');
      return {
        table: 'reservations',
        orgId,
        write: (tx: LedgerTx) =>
          reserve(tx, {
            orgId,
            agentId,
            windowKey: '2026-09-26',
            dimension: 'daily_raw',
            amountRaw: 1_000_000n,
            maxRaw: 5_000_000_000n,
            requestId: newId('txr'),
            idempotencyKey: 'schema-gate',
            policyVersionId: newId('ppv'),
          }),
      };
    })(),
    (() => {
      const orgId = newId('org');
      return {
        table: 'audit_events',
        orgId,
        write: (tx: LedgerTx) =>
          appendEvent(tx, {
            orgId,
            actor: 'system',
            actorType: 'system',
            eventType: 'agent.created',
            metadata: {},
          }),
      };
    })(),
    (() => {
      const orgId = newId('org');
      return {
        table: 'authorization_decisions',
        orgId,
        write: (tx: LedgerTx) =>
          recordDecision(tx, {
            orgId,
            requestId: newId('req'),
            policyVersionId: newId('ppv'),
            outcome: 'DENY',
            digest: null,
          }),
      };
    })(),
  ];

  /**
   * Rows of one table as `ari_app`, on a connection that is brand new for the call.
   *
   * A fresh pool each time, rather than one client whose setting is changed and
   * restored: `set_config(…, false)` is a *session* property, and a scope that
   * outlives the statement that needed it would make the "unscoped" half of this
   * comparison measure whatever the previous probe happened to leave behind.
   *
   * `table` is one of the literals above and is spliced into the statement, because a
   * table name cannot be a bind parameter. Nothing outside this file reaches it; a
   * future edit that turns it into an argument must not either.
   */
  async function readAsApp(table: string, orgId: string | null): Promise<number> {
    const app = await connect(1, 'ari_app');
    try {
      if (orgId !== null) {
        await app.query(`SELECT set_config('ari.org_id', $1, false)`, [orgId]);
      }
      const rows = await app.query<{ n: string }>(`SELECT count(*)::text AS n FROM ari.${table}`);
      return Number(rows.rows[0]?.n ?? '-1');
    } finally {
      await app.end();
    }
  }

  beforeAll(async () => {
    for (const one of cases) {
      await withTransaction(pool, (tx) => one.write(tx));
    }
  });

  it.each(cases.map((one) => [one.table, one.orgId] as const))('%s: none without a scope, its own with one', async (table, orgId) => {
    // Both halves are the assertion. `0` unscoped is only a policy working if the same
    // role, on the same table, can read `1` with the right scope: otherwise this test
    // passes on a role that cannot read anything, or on a table that is simply empty.
    expect(await readAsApp(table, null), `${table} was readable with no tenant scope`).toBe(0);
    expect(await readAsApp(table, orgId), `${table} hid its own tenant's row`).toBe(1);
    // And a *different* tenant's scope must not reach it either — the isolation is
    // symmetric, not an accident of this org being the only one with a row.
    expect(await readAsApp(table, newId('org')), `${table} leaked across tenants`).toBe(0);
  });
});
