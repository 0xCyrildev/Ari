#!/usr/bin/env node
/**
 * `pnpm db:preflight -- <hosted-database-url>` — everything that has to be true about a
 * Postgres before Ari can be pointed at it, checked in one read-only pass.
 *
 * It exists because a hosted database is not the local one with a different hostname.
 * Three properties decide whether Ari runs at all, and each fails in a way the service
 * cannot report from inside:
 *
 *   1. **TLS.** `node-postgres` does not encrypt unless the URL says so, and `apps/api`
 *      and `apps/signer` refuse a non-verifying URL at startup — so a deployment that
 *      pasted a provider's default string never boots, and the preflight says why in one
 *      line instead of through a container restart loop.
 *   2. **Role rights.** `migrations/003_audit.sql` creates `ari_app`, and both services
 *      refuse to open a pool as anything else. A managed login without `CREATEROLE` can
 *      hold every row in the world and still not be able to build the schema.
 *   3. **Session semantics.** The role is set with `-c role=…` *at connect*, which a
 *      transaction-mode pooler discards or hands to someone else. If that probe comes
 *      back with the login role still current, row security is not what stands between
 *      tenants — the `WHERE org_id = …` clauses are — and the service is right to refuse
 *      to start.
 *
 * Nothing here writes. Migrations are `pnpm db:migrate`, seeding is `pnpm seed`, and this
 * script deliberately cannot do either, so it is safe to run against a database you have
 * not decided to use yet.
 */

import { inspectDatabaseUrl, tlsVerdict } from '@ari/ledger';
import { isLoopbackHost } from '@ari/schemas';
import { Client } from 'pg';

// `pnpm db:preflight -- <url>` forwards the `--` as an argument, so a script that read
// argv[2] blindly would try to connect to the string "--" — measured, not guessed.
const positional = process.argv.slice(2).filter((arg) => arg !== '--');
const url = positional[0] ?? process.env.DATABASE_URL ?? '';
const role = positional[1] ?? process.env.DATABASE_ROLE ?? 'ari_app';

if (url.length === 0) {
  console.error('usage: pnpm db:preflight -- <DATABASE_URL> [role the services will connect as]');
  process.exit(2);
}

type Status = 'PASS' | 'WARN' | 'FAIL';
const results: { status: Status; name: string; detail: string }[] = [];
const record = (status: Status, name: string, detail: string) => {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(4)} ${name.padEnd(34)} ${detail}`);
};

// --- 1. the URL itself, before a socket is opened --------------------------------------
const facts = inspectDatabaseUrl(url);
if (facts.problem !== null) record('FAIL', 'connection is encrypted', facts.problem);
else record('PASS', 'connection is encrypted', `${facts.host}:${facts.port} asks for ${facts.sslmode ?? 'ssl=true'}${facts.host === '127.0.0.1' ? ' (loopback: exempt)' : ''}`);

const withoutSecret = url.replace(/:[^:@/]*@/, ':***@');
console.log(`\nrunning against ${withoutSecret} as login, services as role "${role}"\n`);

const login = new Client({ connectionString: url });

try {
  await login.connect();
} catch (error) {
  record('FAIL', 'connects at all', (error as Error).message);
  console.log('\nBLOCKED: nothing below can be checked without a connection.\n');
  await login.end().catch(() => undefined);
  process.exit(1);
}

try {
  // --- 2. is the socket actually TLS, as negotiated, not as requested? ------------------
  // Two views, because they answer different questions and a managed provider separates
  // them: what we asked for, and what the server's own backend sees. Read the reasoning in
  // `tlsVerdict` — the short version is that a proxy makes `pg_stat_ssl` lie by omission.
  const ssl = await login.query<{ ssl: boolean; cipher: string | null; version: string | null }>(
    'SELECT ssl, cipher, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
  );
  const seen = await login.query<{ addr: string | null }>(
    'SELECT inet_client_addr() AS addr FROM pg_stat_activity WHERE pid = pg_backend_pid()',
  );
  const verdict = tlsVerdict(facts.tls, isLoopbackHost(facts.host), {
    serverReportsSsl: ssl.rows[0]?.ssl === true,
    seenClientAddr: seen.rows[0]?.addr ?? null,
  });
  const cipher = ssl.rows[0]?.cipher ? ` cipher=${ssl.rows[0]?.cipher} protocol=${ssl.rows[0]?.version ?? '?'}` : '';
  record(verdict.status === 'pass' ? 'PASS' : verdict.status === 'warn' ? 'WARN' : 'FAIL', 'TLS as negotiated', verdict.detail + cipher);

  const version = await login.query<{ v: string }>('SELECT version() AS v');
  record('PASS', 'server version', (version.rows[0]?.v ?? '?').split(',')[0] as string);

  // --- 3. can this login build what the migrations need? --------------------------------
  const rights = await login.query<{ rolsuper: boolean; rolcreaterole: boolean; name: string }>(
    'SELECT rolname AS name, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user',
  );
  const me = rights.rows[0];
  const roleExists = await login.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [role]);
  const alreadyThere = (roleExists.rows[0]?.n ?? 0) > 0;

  if (alreadyThere) {
    record('PASS', `role ${role} exists`, 'the services can be pointed at it now');
  } else if (me?.rolsuper || me?.rolcreaterole) {
    record('PASS', `role ${role} creatable`, `login "${me.name}" may create it; run pnpm db:migrate`);
  } else {
    record('FAIL', `role ${role} creatable`, `login "${me?.name ?? '?'}" has neither SUPERUSER nor CREATEROLE — ask the provider for it, or create the role and GRANT it to this login`);
  }

  // --- 4. the probe that decides whether a pooler is in the way --------------------------
  const scoped = new Client({ connectionString: url, options: `-c role=${role}` });
  try {
    await scoped.connect();
    const who = await scoped.query<{ session_user: string; current_user: string }>('SELECT session_user, current_user');
    const { session_user: sessionUser, current_user: currentUser } = who.rows[0] ?? { session_user: '?', current_user: '?' };
    if (currentUser === role) {
      record('PASS', 'role-at-connect survives', `session_user=${sessionUser}, current_user=${currentUser} — session semantics, row security will apply`);
    } else {
      record(
        'FAIL',
        'role-at-connect survives',
        `asked for ${role}, got ${currentUser}. Something between here and the server is a transaction-mode pooler, and both services refuse to start rather than run as the table owner. Use the direct/session endpoint.`,
      );
    }

    // A pooler that survives the role probe can still break the one thing the audit chain
    // depends on: a session-scoped advisory lock held across statements. Three separate
    // queries, because a parameterised multi-statement string goes down the extended
    // protocol, which refuses it — and a refusal we caused is not a finding about the proxy.
    try {
      await scoped.query('BEGIN');
      const lock = await scoped.query<{ got: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got',
        ['ari-preflight'],
      );
      await scoped.query('ROLLBACK');
      if (lock.rows[0]?.got) record('PASS', 'advisory lock available', 'pg_try_advisory_xact_lock(hashtextextended(...)) answered');
      else record('FAIL', 'advisory lock available', 'the lock could not be taken, which means something already holds it — the audit chain assumes it is alone');
    } catch (error) {
      await scoped.query('ROLLBACK').catch(() => undefined);
      record('WARN', 'advisory lock available', `${(error as Error).message} — if the proxy rejects this, the audit chain cannot be serialised`);
    }
    await scoped.end();
  } catch (error) {
    record('FAIL', 'role-at-connect survives', (error as Error).message);
    await scoped.end().catch(() => undefined);
  }

  // --- 5. is the schema there yet? -------------------------------------------------------
  const shaped = await login.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'ari' AND table_name = 'transaction_requests'`,
  );
  if ((shaped.rows[0]?.n ?? 0) === 0) {
    record('WARN', 'schema migrated', 'ari.transaction_requests is not there — run pnpm db:migrate (this script never writes)');
  } else {
    // The same predicate `tests/security/schema.test.ts` asserts, on purpose: a table
    // carrying `org_id` must be behind row security, and `signing_tickets` is the one
    // named exception because the signer redeems across tenants and has no scope to set.
    // `organizations` is not an exception and needs no listing — it has no `org_id`,
    // because it *is* the tenant.
    const rls = await login.query<{ relname: string; rowSecurity: boolean; hasOrgColumn: boolean }>(
      `SELECT c.relname::text AS relname,
              c.relrowsecurity AS "rowSecurity",
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped) AS "hasOrgColumn"
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ari' AND c.relkind = 'r' ORDER BY 1`,
    );
    const unguarded = rls.rows.filter((r) => r.hasOrgColumn && !r.rowSecurity).map((r) => r.relname);
    const scoped = rls.rows.filter((r) => r.hasOrgColumn && r.rowSecurity).length;
    if (unguarded.length === 1 && unguarded[0] === 'signing_tickets') {
      record('PASS', 'row security on money tables', `${scoped} tenant-bearing tables behind policies; signing_tickets exempt by design (011)`);
    } else {
      record('FAIL', 'row security on money tables', `expected only signing_tickets unscoped, found: ${unguarded.join(', ') || 'nothing'} — a half-applied migration, not a clean database`);
    }
  }

  // --- 6. headroom for the two pools -----------------------------------------------------
  const max = await login.query<{ v: string }>("SELECT setting AS v FROM pg_settings WHERE name = 'max_connections'");
  const used = await login.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity');
  const ceiling = Number(max.rows[0]?.v ?? '0');
  const needed = 10 + 8 + 4; // ari-api's pool, ari-signer's pool, and room for one migration and one human
  if (ceiling > 0 && ceiling < needed) {
    record('WARN', 'connection headroom', `max_connections=${ceiling}, in use=${used.rows[0]?.n ?? '?'}, the two services want ${needed} — replicas multiply this`);
  } else {
    record('PASS', 'connection headroom', `max_connections=${ceiling || '?'}, in use=${used.rows[0]?.n ?? '?'}, services plan for ${needed}`);
  }
} finally {
  await login.end().catch(() => undefined);
}

const failed = results.filter((r) => r.status === 'FAIL');
const warned = results.filter((r) => r.status === 'WARN');
console.log(
  `\n${results.length - failed.length - warned.length} pass, ${warned.length} warn, ${failed.length} fail — ` +
    (failed.length === 0 ? 'this database can hold Ari.' : 'fix the failures above before pointing a service at it.'),
);
process.exit(failed.length === 0 ? 0 : 1);
