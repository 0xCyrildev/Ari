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
import { behaviouralProvider } from '@ari/risk-engine';
import { EvmForkProvider, type EvmProviderConfig } from '@ari/simulation';
import { TicketKey, isLoopbackHost } from '@ari/signing';
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
  /**
   * The bearer this process presents at the authority plane, or null when the signer is
   * on loopback and the operator accepted no gate. Not optional-with-a-default beyond
   * loopback: `readConfig` refuses that combination, because the alternative is a ticket
   * standing alone between a stranger and a signature attempt.
   */
  readonly signerDeliveryKey: string | null;
  /**
   * The interface to bind. Loopback by default, because a service that comes up reachable on
   * every interface is a service whose owner did not choose that. A platform that fronts it
   * with a proxy sets `API_HOST=0.0.0.0` and terminates TLS in front; saying it out loud in
   * configuration is the point, not an obstacle.
   */
  readonly host: string;
  /** Null is a configuration, not an omission — see `PipelineDeps.simulation`. */
  readonly simulation: EvmProviderConfig | null;
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
  // The delivery secret is the same value the signer holds, and this is the only process
  // allowed to send it. Absenting it is an option on loopback alone, where the socket is
  // already the access control; anything beyond it must name a credential or not start.
  const signerUrl = env.SIGNER_URL ?? 'http://127.0.0.1:4100/v1/sign';
  const signerDeliverySecret = env.SIGNER_DELIVERY_KEY ?? '';
  let signerHost = '';
  try {
    signerHost = new URL(signerUrl).hostname;
  } catch {
    problems.push('SIGNER_URL must be an absolute URL');
  }
  if (signerDeliverySecret.length > 0 && signerDeliverySecret.length < 32) {
    problems.push('SIGNER_DELIVERY_KEY must be at least 32 characters when set (openssl rand -base64 48)');
  }
  if (signerDeliverySecret.length === 0 && signerHost.length > 0 && !isLoopbackHost(signerHost)) {
    problems.push(`SIGNER_DELIVERY_KEY is required when SIGNER_URL points beyond loopback (${signerHost}): a ticket would be the only thing between a stranger and a signature attempt`);
  }
  // Simulation is the one plane that may be absent, and its absence is decided here rather
  // than at first use: a half-configured provider (a URL with no chain id) is a
  // configuration error, and the alternative is a process that comes up, silently never
  // simulates, and leaves a policy written against `onSimulationUnavailable: deny` refusing
  // every payment for a reason nothing in the log names.
  let simulation: EvmProviderConfig | null = null;
  const simulationUrl = env.SIM_RPC_URL ?? '';
  if (simulationUrl.length > 0) {
    const chainId = env.SIM_CHAIN_ID ?? '';
    if (!/^\d{1,39}$/.test(chainId)) problems.push('SIM_CHAIN_ID is required when SIM_RPC_URL is set, as a decimal integer');
    const staleness = env.SIM_MAX_STALENESS_SECONDS;
    if (staleness !== undefined && !/^\d{1,9}$/.test(staleness)) problems.push('SIM_MAX_STALENESS_SECONDS must be a whole number of seconds');
    const timeout = env.SIM_TIMEOUT_MS;
    if (timeout !== undefined && !/^\d{1,5}$/.test(timeout)) problems.push('SIM_TIMEOUT_MS must be at most five digits');
    if (problems.length === 0) {
      simulation = {
        url: simulationUrl,
        chainId,
        ...(env.SIM_BLOCK_TAG === undefined || env.SIM_BLOCK_TAG.length === 0 ? {} : { blockTag: env.SIM_BLOCK_TAG }),
        ...(staleness === undefined ? {} : { maxStalenessSeconds: Number(staleness) }),
        ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
      };
    }
  }

  if (problems.length > 0) throw new Error(`ari-api cannot start:\n  - ${problems.join('\n  - ')}`);

  return {
    databaseUrl,
    databaseRole,
    masterPepper,
    ticketKey: new TicketKey(ticketSecret),
    approvalKey: new ApprovalKey(approvalSecret),
    bootstrapToken,
    signerUrl,
    signerDeliveryKey: signerDeliverySecret.length === 0 ? null : signerDeliverySecret,
    port: Number(env.API_PORT ?? env.PORT ?? '4000'),
    host: env.API_HOST ?? '127.0.0.1',
    simulation,
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
    // On by default, because it needs no external service: the baselines are
    // aggregates over Ari's own `transaction_requests`, read in the same tenant
    // transaction as the decision. A deployment that would rather not consult risk has
    // to say so with a provider, not by leaving the field out — the kernel escalates
    // when nothing assessed, so the absent provider is the loudest configuration.
    risk: behaviouralProvider(),
    // Constructed here, so a URL that is neither TLS nor loopback — or a block tag the
    // provider will not accept — fails the process at startup rather than arriving as an
    // endless stream of `SIMULATED_UNAVAILABLE` answers.
    simulation: config.simulation === null ? null : new EvmForkProvider(config.simulation),
  };

  const app = fastify({ logger: false, bodyLimit: 64 * 1024 });
  const routeDeps: RouteDeps = {
    pipeline: deps,
    signer: signer ?? createSignerClient({ url: config.signerUrl, deliveryKey: config.signerDeliveryKey }),
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
  await api.app.listen({ host: config.host, port: config.port });
  console.log(`ari-api listening on ${config.host}:${config.port}`);
  // `API_HOST` was named in `.env.example` and read by nothing: the process always bound
  // loopback, so a deployment behind a platform proxy accepted connections from the container
  // and nowhere else, and the health check passed. Non-loopback is legitimate on a PaaS and
  // reckless on a laptop, so it is stated rather than assumed.
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    process.stderr.write(`ari-api: bound to ${config.host}, reachable beyond this machine. TLS must terminate in front of it: bearer credentials and the bootstrap token cross this socket.\n`);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void api.close().then(() => process.exit(0));
    });
  }
}
