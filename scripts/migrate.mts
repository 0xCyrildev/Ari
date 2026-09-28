/**
 * `pnpm db:migrate` — apply the schema to a database that has never seen it.
 *
 * Until now the only thing that ran `migrations/*.sql` was `tests/security/global-setup.ts`,
 * which is written for a test box: it connects, applies everything, and **warns and continues**
 * when nothing answers, because `pnpm test:unit` runs the no-database half on a machine with no
 * container. That is the right behaviour for a test runner and a dangerous one for a deploy:
 * a first boot that prints a warning and serves traffic is a service with no tables, and the
 * first failure an operator sees will be a foreign-key error at 03:00.
 *
 * So this is the same loop with the opposite contract. No database is an error, not a skip. A
 * migration that throws stops the run, names the file, and rolls back that file's own
 * transaction — every file is applied inside one transaction, so a half-applied migration is not
 * a state this script can leave behind.
 *
 * It applies **all** files, every time, in name order. That is not carelessness, it is the
 * repository's rule: each file is idempotent by policy (`CREATE TABLE IF NOT EXISTS`,
 * `DROP CONSTRAINT IF EXISTS` by both the current and the previous name), because the test suite
 * re-applies the whole directory on every run. A version table would let a file slip into
 * non-idempotence unnoticed, since nothing would ever run it twice. The day a migration cannot
 * be re-applied, it must be split rather than tracked.
 *
 * It connects as the URL's login, which must own the `ari` schema: the files create tables,
 * roles-granted objects and triggers. On a managed database where the provided login cannot do
 * that, run this against a role with the rights and leave the services on `ari_app`.
 */

import { inspectDatabaseUrl } from '@ari/ledger';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ari:ari@127.0.0.1:5435/ari';
const DATABASE_ROLE = process.env.DATABASE_ROLE ?? '';

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`db:migrate: no .sql files found in ${MIGRATIONS_DIR}`);
  process.exit(1);
}

// The same rule the two services enforce, and this connection is the one carrying role
// grants, triggers and the login password — the least forgiving plaintext hop of the three.
{
  const db = inspectDatabaseUrl(DATABASE_URL);
  if (db.problem !== null) {
    console.error(`db:migrate: ${db.problem}`);
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });

try {
  // Reachability first, with the file named: the failure mode of a wrong URL on a deploy
  // platform is a silent no-op, and this is the one place that can say "nothing is there".
  const probe = await pool.query<{ role: string; schema: boolean }>(
    `SELECT current_user AS role,
            EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'ari') AS schema`,
  );
  const who = probe.rows[0]?.role ?? 'unknown';
  console.log(`db:migrate: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')} as ${who}, ${files.length} files`);

  for (const name of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${name}`, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`  applied  ${name}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAILED   ${name}: ${message}`);
      console.error('db:migrate: stopped. Nothing after this file was attempted, and this file was rolled back.');
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }

  if (process.exitCode !== 1) {
    // The role the services will connect as must exist and be grantable, or `ari-api` refuses
    // to start later with a message about a role name and no hint about why.
    if (DATABASE_ROLE.length > 0) {
      const role = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`,
        [DATABASE_ROLE],
      );
      console.log(
        role.rows[0]?.n
          ? `  role     ${DATABASE_ROLE} exists; the services connect as it`
          : `  MISSING  role ${DATABASE_ROLE}: create it and GRANT it to the login, or ari-api will refuse to start`,
      );
    }
    console.log('db:migrate: done.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`db:migrate: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')} is not usable: ${message}`);
  console.error('This is a failure, not a skip. Nothing was applied.');
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
