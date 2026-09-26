/**
 * One schema, applied once, before any worker starts.
 *
 * Each security file used to run the migration series itself under an advisory
 * lock, and the advisory lock guarded against nothing that mattered: `DROP TRIGGER`
 * and `CREATE TRIGGER` take an ACCESS EXCLUSIVE lock on the table, which deadlocks
 * against any other suite's in-flight INSERT no matter who holds which advisory
 * key. The fix is not a better lock — it is that DDL and concurrent DML do not
 * belong in the same phase of a test run.
 *
 * A missing database is not an error here: the suites that need one fail loudly on
 * connect, and `pnpm test:unit` should not depend on a container.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ari:ari@127.0.0.1:5435/ari';

export default async function setup(): Promise<() => Promise<void>> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => `${MIGRATIONS_DIR}/${name}`);

  let pool: Pool | null = null;
  try {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await pool.query('SELECT 1');
  } catch (error) {
    await pool?.end().catch(() => undefined);
    // *Nothing answering* is the only failure that may pass quietly, and only because
    // `pnpm test:unit` runs the no-database half on a machine with no container.
    console.warn(`[ari] security migrations skipped — ${DATABASE_URL} unreachable (${(error as Error).message})`);
    return async () => undefined;
  }

  // The name the failure has to report is the loop variable, which dies with the loop
  // — so it is carried out here, pre-assigned to the first file so a failure on the
  // very first statement still names it.
  let current = files[0] ?? '<no migrations found>';
  try {
    for (const file of files) {
      current = file;
      await pool.query(readFileSync(file, 'utf8'));
    }
  } catch (error) {
    // A migration that *ran and failed* is a different event entirely, and folding it
    // into the message above produced a suite that passed against a half-migrated
    // schema while printing "unreachable" about a constraint error. The database is
    // there; the DDL is wrong; every gate that depends on that DDL is now measuring
    // something other than the thing it claims. Fail the run, name the file.
    await pool.end().catch(() => undefined);
    throw new Error(`[ari] migration ${current} failed against ${DATABASE_URL}: ${(error as Error).message}`);
  }

  return async () => {
    await pool?.end();
  };
}
