/**
 * `ari-api` — the decision plane as a process.
 *
 * Configuration is refused rather than defaulted, in two places specifically: no
 * bootstrap token means no organisation endpoint (an open one is §5.6's abuse
 * surface), and no database means nothing that could enforce a limit. A service that
 * starts up "helpfully" with permissive settings is a vulnerability with a health
 * check.
 */

import { ApprovalKey, type Seal as ApprovalSeal } from '@ari/approvals';
import { inspectDatabaseUrl, probeDatabase } from '@ari/ledger';
import { behaviouralProvider } from '@ari/risk-engine';
import { isLoopbackHost } from '@ari/schemas';
import { EvmForkProvider, type EvmProviderConfig } from '@ari/simulation';
import { ringOf, TicketKey, type Seal } from '@ari/signing';
import fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import { Pool } from 'pg';
import type { PipelineDeps } from './authorize.js';
import type { ChainBindingConfig } from './chain-artifact.js';
import { chainBindingFromEnv } from './chain-config.js';
import { ApiMetrics } from './metrics.js';
import { fastifyOptions, logLevelOf, registerRequestId, type LogLevel } from './observe.js';
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
  /** Mandatory. A deployment that cannot name its fee bounds and its tokens does not start. */
  readonly chain: ChainBindingConfig;
  readonly masterPepper: string;
  readonly ticketKey: Seal<TicketKey>;
  readonly approvalKey: ApprovalSeal<ApprovalKey>;
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
  /**
   * pino's level, and the one setting here that is allowed to be wrong without stopping
   * anything: a typo in a log level must not take a payment service down.
   */
  readonly logLevel: LogLevel;
  /**
   * The bearer that makes `GET /metrics` exist. Null is not "metrics are open" — it is
   * "there is no metrics route", answered by the same 404 as any unknown path. A
   * deployment that scraped nothing would otherwise be publishing its request volume on
   * a public hostname, which is a cross-tenant inference channel with no principal in
   * front of it (T20).
   */
  readonly metricsToken: string | null;
  /** Goes into `ari_api_build_info`. `dev` is the honest answer when nobody injected one. */
  readonly version: string;
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

  if (databaseUrl.length === 0) {
    problems.push('DATABASE_URL is required');
  } else {
    // A hosted database reached over a plaintext socket is not a degraded connection, it
    // is a different security property: the row security that `011` exists to enforce is
    // only worth anything if the party answering the query is the database.
    const db = inspectDatabaseUrl(databaseUrl);
    if (db.problem !== null) problems.push(db.problem);
  }
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

  // Rotation, as far as a configuration can take it: a head that signs and one previous
  // seal still honoured. The previous secret is useless without its id, because the whole
  // point of naming a key is to be able to say out loud which one is being retired — and a
  // ring whose members cannot be named is how an operator ends up trusting a secret they
  // believe they dropped. See `docs/OPERATIONS.md` for the order the two processes go in.
  const ticketPrevious = env.TICKET_KEY_PREVIOUS ?? '';
  const approvalPrevious = env.APPROVAL_KEY_PREVIOUS ?? '';
  if (ticketPrevious.length > 0 && (env.TICKET_KEY_PREVIOUS_ID ?? '').length === 0) {
    problems.push('TICKET_KEY_PREVIOUS_ID is required when TICKET_KEY_PREVIOUS is set');
  }
  if (approvalPrevious.length > 0 && (env.APPROVAL_KEY_PREVIOUS_ID ?? '').length === 0) {
    problems.push('APPROVAL_KEY_PREVIOUS_ID is required when APPROVAL_KEY_PREVIOUS is set');
  }
  if (ticketPrevious.length > 0 && ticketPrevious.length < 32) problems.push('TICKET_KEY_PREVIOUS must be at least 32 characters when set');
  if (approvalPrevious.length > 0 && approvalPrevious.length < 32) problems.push('APPROVAL_KEY_PREVIOUS must be at least 32 characters when set');

  if (problems.length > 0) throw new Error(`ari-api cannot start:\n  - ${problems.join('\n  - ')}`);

  const metricsSecret = env.METRICS_TOKEN ?? '';
  // The same two rules the delivery gate runs, for the same reason: a length floor that a
  // truncated paste can still satisfy is not a floor, and presence enforces — but here the
  // failure mode of setting nothing is a closed endpoint, never an open one.
  if (metricsSecret.length > 0 && metricsSecret.length < 32) {
    throw new Error('ari-api cannot start:\n  - METRICS_TOKEN must be at least 32 characters when set (openssl rand -base64 48)');
  }

  return {
    databaseUrl,
    databaseRole,
    chain: chainBindingFromEnv(env),
    masterPepper,
    ticketKey: ringOf(
      new TicketKey(ticketSecret, env.TICKET_KEY_ID ?? 'v1'),
      ticketPrevious.length === 0 ? undefined : new TicketKey(ticketPrevious, env.TICKET_KEY_PREVIOUS_ID!),
    ),
    approvalKey: ringOf(
      new ApprovalKey(approvalSecret, env.APPROVAL_KEY_ID ?? 'v1'),
      approvalPrevious.length === 0 ? undefined : new ApprovalKey(approvalPrevious, env.APPROVAL_KEY_PREVIOUS_ID!),
    ),
    bootstrapToken,
    signerUrl,
    signerDeliveryKey: signerDeliverySecret.length === 0 ? null : signerDeliverySecret,
    port: Number(env.API_PORT ?? env.PORT ?? '4000'),
    host: env.API_HOST ?? '127.0.0.1',
    simulation,
    logLevel: logLevelOf(env),
    metricsToken: metricsSecret.length === 0 ? null : metricsSecret,
    version: env.ARI_VERSION ?? 'dev',
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
 *
 * `logger` is the same seam for the other half: pass a `FastifyBaseLogger` and this
 * process writes its one JSON line per event into it instead of into pino on stdout.
 * Without it, what an operator reads is the log; with it, a test can assert that the
 * line exists, that it names the error, and that it does not carry the digest — which is
 * the actual claim, and spying on `process.stdout` to check it would only have proven
 * whatever pino happens to do with a pipe that day.
 */
export async function startApi(config: ApiConfig, signer?: SignerClient, logger?: FastifyBaseLogger): Promise<RunningApi> {
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
    chain: config.chain,
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

  const metrics = new ApiMetrics(config.version);
  // The pool's own counters, re-read on every change rather than incremented here: `pg`
  // already knows the truth, and a counter this process keeps can drift from it. This is
  // the metric that answers "is the database connection the bottleneck" without a query.
  const readPool = () => {
    metrics.notePool({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  };
  // `wait` is not an event `pg` emits (the type says so, and it was right): a client that
  // cannot be had shows up as `waiting` on the pool, which `readPool` already reports.
  for (const event of ['acquire', 'release', 'remove'] as const) {
    pool.on(event, readPool);
  }
  readPool();

  // `logger: false` used to sit here, which made `app.log` a no-op and turned every
  // deliberate silence *outward* into silence *inward* as well. The outward rules are
  // unchanged — a 500 still answers `{code:'INTERNAL'}` and nothing else — but the reason
  // this process refused is now written down somewhere the operator can read.
  const app = fastify(fastifyOptions({ level: config.logLevel, loggerInstance: logger }));
  registerRequestId(app);
  app.addHook('onResponse', (request, reply) => {
    metrics.noteRequest({
      // The compiled route (`/v1/transactions/:id`), never the path a caller typed: an
      // label drawn from the request would let anyone mint unbounded cardinality on a
      // scrape endpoint. Anything that matched no route shares one label.
      route: request.routeOptions.url ?? 'unmatched',
      method: request.method,
      status: reply.statusCode,
      seconds: reply.elapsedTime / 1000,
    });
  });

  // The one dependency the health answer needs that is not already in the pipeline: a
  // statement that proves the pool can open. Shared with `ari-signer` through
  // `probeDatabase`, because two processes disagreeing about "healthy" is two health
  // checks rather than one fact.
  const health = () => probeDatabase(pool);

  const routeDeps: RouteDeps = {
    pipeline: deps,
    signer: signer ?? createSignerClient({ url: config.signerUrl, deliveryKey: config.signerDeliveryKey }),
    bootstrapToken: config.bootstrapToken,
    metrics,
    health,
    metricsToken: config.metricsToken,
    version: config.version,
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
    // Plain text, and deliberately so: this failure happens before there is a logger to
    // write through, and a refusal to start is the one line an operator reads on a
    // terminal rather than in a drain.
    console.error((error as Error).message);
    process.exit(2);
  }
  const api = await startApi(config);
  await api.app.listen({ host: config.host, port: config.port });
  api.app.log.info({ host: config.host, port: config.port, version: config.version }, 'ari-api listening');
  // `API_HOST` was named in `.env.example` and read by nothing: the process always bound
  // loopback, so a deployment behind a platform proxy accepted connections from the container
  // and nowhere else, and the health check passed. Non-loopback is legitimate on a PaaS and
  // reckless on a laptop, so it is stated rather than assumed.
  //
  // `isLoopbackHost`, not a two-value comparison: `::1` is loopback and would have been
  // warned about, and the warning is the thing an operator is told to read as a decision.
  if (!isLoopbackHost(config.host)) {
    api.app.log.warn({ host: config.host }, 'ari-api is bound beyond this machine. TLS must terminate in front of it: bearer credentials and the bootstrap token cross this socket');
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void api.close().then(() => process.exit(0));
    });
  }
}
