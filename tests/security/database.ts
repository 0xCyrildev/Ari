import { Pool } from 'pg';
import { DATABASE_URL } from './global-setup.js';

export { DATABASE_URL };

/**
 * A pool for a suite that needs real transactions.
 *
 * The schema is applied once, before any worker starts (`global-setup.ts`), so
 * nothing here runs DDL: an `ALTER TABLE` in flight while another suite inserts is
 * an access-exclusive lock meeting a row-exclusive one, and Postgres resolves that
 * by killing one of them.
 *
 * It does not skip when the database is absent, deliberately. These suites are the
 * Phase 1 and Phase 2 gates, and both are about behaviour only a transaction can
 * show — a row lock, a trigger, a grant, a policy. A skipped gate reads as a passed
 * one in every summary that matters.
 */
export async function connect(max = Number(process.env.ARI_TEST_POOL_MAX ?? '6')): Promise<Pool> {
  const pool = new Pool({ connectionString: DATABASE_URL, max });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(
      `Postgres is not reachable at ${DATABASE_URL} (${(error as Error).message}). Run \`pnpm db:up\`.`,
    );
  }
  return pool;
}
