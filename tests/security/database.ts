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
 *
 * `as` opens every connection in the pool *already* holding that role, through the
 * same `-c role=` startup parameter `ari-api` and `ari-signer` use — not through a
 * `SET ROLE` issued on one client. A client that is told to change role and then
 * handed back to the pool keeps it, so the next test to borrow that connection is
 * running with privileges nobody chose; and now that row security covers the money
 * tables, it is also running with no tenant scope, which reads as an empty database
 * rather than as a mistake. Setting the role at open makes the pool the thing under
 * test, not an accident of which client was reused.
 */
export async function connect(
  max = Number(process.env.ARI_TEST_POOL_MAX ?? '6'),
  as?: string,
): Promise<Pool> {
  // A role name goes into a connection parameter, which takes no bind variable, so
  // it is checked rather than quoted — the same pattern `apps/api` refuses on.
  if (as !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(as)) {
    throw new Error(`connect(): "${as}" is not a plain Postgres role name`);
  }
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max,
    ...(as === undefined ? {} : { options: `-c role=${as}` }),
  });
  try {
    // Asserting the role actually landed: a login that is not a member of it fails
    // loudly here instead of testing the owner's privileges in its place.
    const probe = await pool.query<{ role: string }>('SELECT current_user AS role');
    if (as !== undefined && probe.rows[0]?.role !== as) {
      throw new Error(`connect(): asked for role "${as}", the connection came up as "${probe.rows[0]?.role ?? 'unknown'}"`);
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(
      `Postgres is not usable at ${DATABASE_URL} (${(error as Error).message}). Run \`pnpm db:up\`.`,
    );
  }
  return pool;
}

/**
 * The chain binding a security-suite deployment pretends to have.
 *
 * Mandatory in the type, so every suite that mints a ticket has to say which tokens exist and what fee
 * it will tolerate — which is the point of making it required. These are test values, and the contract is
 * the same USDC address every suite already builds candidates against.
 */
export const TEST_ARTIFACT = {
  chain: 'evm' as const,
  signingDigest: 'evm/keccak256-signing-v1:' + 'a1'.repeat(32),
  // Null because it is EVM and nothing has signed these bytes — the same answer production gives.
  txDigest: null,
  bytesSha256: 'b2'.repeat(32),
  byteLength: 114n,
};

export const TEST_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

export const testChainBinding = {
  supported: ['evm'] as const,
  networkName: 'mainnet' as const,
  allowedChainIds: ['1'],
  maxFeeCostWei: 10n ** 17n,
  maxGasLimit: 500_000n,
  tokens: { [TEST_USDC]: { decimals: 6n, symbol: 'USDC' } },
};
