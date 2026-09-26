import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const MIGRATIONS = ['001_accounting.sql', '002_decisions_and_tickets.sql'].map((name) =>
  fileURLToPath(new URL(`../../packages/ledger/sql/${name}`, import.meta.url)),
);

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ari:ari@127.0.0.1:5435/ari';

/**
 * A real Postgres, or a loud stop.
 *
 * These suites are the Phase 1 and Phase 2 gates, and both are about behaviour
 * only a transaction can show — a row lock, a trigger, a `CHECK`. Skipping when
 * the database is absent would make the suite greenest exactly when nobody has
 * looked at the thing it exists to check.
 */
export async function connect(): Promise<Pool> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 16 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(
      `Postgres is not reachable at ${DATABASE_URL} (${(error as Error).message}). ` +
        'This suite does not skip: run `pnpm db:up`.',
    );
  }
  // The DDL is idempotent but not concurrency-safe: two vitest workers sharing one
  // database dropping and recreating the same trigger race each other ("tuple
  // concurrently updated"), which reads as a product defect and is a test
  // harness one. An advisory lock makes "has the schema been applied" a single
  // serial question.
  const lock = await pool.connect();
  try {
    await lock.query(`SELECT pg_advisory_lock(hashtext('ari:test-schema'))`);
    for (const file of MIGRATIONS) {
      await lock.query(readFileSync(file, 'utf8'));
    }
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('ari:test-schema'))`).catch(() => undefined);
    lock.release();
  }
  return pool;
}
