/**
 * `ari-api` — the decision plane as a process.
 *
 * Configuration is refused rather than defaulted, in two places specifically: no
 * bootstrap token means no organisation endpoint (an open one is §5.6's abuse
 * surface), and no database means nothing that could enforce a limit. A service that
 * starts up "helpfully" with permissive settings is a vulnerability with a health
 * check.
 */

import { ApprovalKey } from '@ari/approvals';
import { TicketKey } from '@ari/signing';
import fastify from 'fastify';
import { Pool } from 'pg';
import type { PipelineDeps } from './authorize.js';
import { registerRoutes, type RouteDeps } from './routes.js';
import { createSignerClient, type SignerClient } from './signer-client.js';

export interface ApiConfig {
  readonly databaseUrl: string;
  /**
   * The role every pooled connection sets at connect time, and the reason it is a
   * The reason it is a default rather than an opt-in: `ari` owns these tables, and a
   * table owner sits outside row security by definition. A deployment that forgets this variable then
   * runs out of the grants `008` had to add by hand, and every tenant filter in the
   * codebase is the only thing between one organisation and another's rows. Running
   * unprivileged and failing loudly is the safe direction for a forgotten setting;
   * running as the owner and working fine is not.
   */
  readonly databaseRole: string;
  readonly masterPepper: string;
  readonly ticketKey: TicketKey;
  readonly approvalKey: ApprovalKey;
  readonly bootstrapToken: string;
  readonly signerUrl: string;
  readonly port: number;
}

/** A role name goes into `SET ROLE`, which takes no parameter — so it is checked, not quoted. */
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function readConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const problems: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? '';
  const databaseRole = env.DATABASE_ROLE ?? 'ari_app';
  const masterPepper = env.CREDENTIAL_PEPPER ?? '';
  const ticketSecret = env.TICKET_KEY ?? '';
  const approvalSecret = env.APPROVAL_KEY ?? '';
  const bootstrapToken = env.ORG_BOOTSTRAP_TOKEN ?? '';

  if (databaseUrl.length === 0) problems.push('DATABASE_URL is required');
  if (!ROLE_PATTERN.test(databaseRole)) problems.push('DATABASE_ROLE must be a plain Postgres role name');
  if (masterPepper.length < 32) problems.push('CREDENTIAL_PEPPER must be at least 32 characters');
  if (ticketSecret.length < 32) problems.push('TICKET_KEY must be at least 32 characters');
  if (approvalSecret.length < 32) problems.push('APPROVAL_KEY must be at least 32 characters');
  // An empty token here means "the endpoint is closed", not "anyone may create a
  // tenant"; the failure mode of a forgotten variable is an outage, never a hole.
  if (bootstrapToken.length < 16) problems.push('ORG_BOOTSTRAP_TOKEN must be at least 16 characters');
  if (problems.length > 0) throw new Error(`ari-api cannot start:\n  - ${problems.join('\n  - ')}`);

  return {
    databaseUrl,
    databaseRole,
    masterPepper,
    ticketKey: new TicketKey(ticketSecret),
    approvalKey: new ApprovalKey(approvalSecret),
    bootstrapToken,
    signerUrl: env.SIGNER_URL ?? 'http://127.0.0.1:4100/v1/sign',
    port: Number(env.API_PORT ?? '4000'),
  };
}

export interface RunningApi {
  readonly app: ReturnType<typeof fastify>;
  readonly deps: PipelineDeps;
  close(): Promise<void>;
}

/**
 * `signer` exists so the delivery step can be observed in tests without a second
 * process. It is optional rather than part of `ApiConfig` because a deployment that
 * cannot reach its signer has a configuration error, and that should fail loudly at
 * startup rather than arrive as a stub nobody meant to leave in.
 */
export async function startApi(config: ApiConfig, signer?: SignerClient): Promise<RunningApi> {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    // The role is set where the connection is opened rather than by a `SET ROLE` on
    // every checkout: `-c role=` is applied by the backend before it answers the
    // first query, so there is no window in which a pooled connection is live under
    // the wrong identity, and no round trip per transaction. `session_user` stays the
    // login role, which is what the audit trail reads to tell the two apart.
    //
    // It is also a session-wide setting, so this pool must not sit behind a
    // transaction-mode pooler — one that hands the connection to someone else between
    // statements would hand them the role too.
    options: `-c role=${config.databaseRole}`,
  });
  pool.on('error', () => {
    // A connection dying in the background. Nothing to recover here — the pool opens
    // a replacement — but an unhandled `error` event on an EventEmitter throws.
  });
  // Fail at startup rather than at the first request. `ari_app` is NOINHERIT, so a
  // login role it was never granted to does not degrade quietly: the backend refuses
  // to open at all, and this is where that becomes a named cause rather than the first
  // agent request of the day.
  let role: string | undefined;
  try {
    const probe = await pool.query<{ role: string }>(`SELECT current_user AS role`);
    role = probe.rows[0]?.role;
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(`ari-api cannot start:\n  - the database refused "${config.databaseRole}": ${(error as Error).message}`);
  }
  if (role !== config.databaseRole) {
    await pool.end().catch(() => undefined);
    throw new Error(`ari-api cannot start:\n  - the connection reads as "${role ?? 'unknown'}", not "${config.databaseRole}"`);
  }
  const deps: PipelineDeps = {
    pool,
    ticketKey: config.ticketKey,
    approvalKey: config.approvalKey,
    masterPepper: config.masterPepper,
    // The decision plane reads its own clock. Every component that checks an expiry
    // does so against a time it supplies, so a disagreement between planes is a
    // visible refusal rather than a silent pass.
    nowMs: () => BigInt(Date.now()),
  };

  const app = fastify({ logger: false, bodyLimit: 64 * 1024 });
  const routeDeps: RouteDeps = {
    pipeline: deps,
    signer: signer ?? createSignerClient({ url: config.signerUrl }),
    bootstrapToken: config.bootstrapToken,
  };
  registerRoutes(app, routeDeps);
  await app.ready();

  return {
    app,
    deps,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  let config: ApiConfig;
  try {
    config = readConfig(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const api = await startApi(config);
  await api.app.listen({ host: '127.0.0.1', port: config.port });
  console.log(`ari-api listening on 127.0.0.1:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void api.close().then(() => process.exit(0));
    });
  }
}
