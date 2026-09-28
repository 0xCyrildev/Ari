/**
 * `ari-signer` — the authority plane as its own process (assumption A2).
 *
 * Two things are true of this file and neither is negotiable: it will not start
 * without a sealing key of its own, and it will not start pretending to be Ika.
 * The second one is why `SIGNING_PROVIDER` other than `mock` exits rather than
 * falling back — a deployment that silently signs with a mock has produced
 * signatures that mean nothing, and the only thing worse than an unavailable
 * signer is an unavailable signer that reports success.
 */

import { claimTicket, inspectDatabaseUrl, withTransaction } from '@ari/ledger';
import { isLoopbackHost } from '@ari/schemas';
import {
  MockSigningProvider,
  TicketKey,
  redeemAndSign,
  type SignerDeps,
  type TicketStore,
} from '@ari/signing';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createSignHandler } from './handler.js';
import { createSignerRequestHandler } from './http.js';

export interface SignerConfig {
  readonly ticketKey: TicketKey;
  readonly databaseUrl: string;
  /**
   * Same rule as the decision plane, same reason: this process is the one holding the
   * sealing key, so it is the one whose database access most wants to be unable to
   * write anything it was not given a grant for. `ari` owns the tables and is outside
   * row security; `ari_app` is what `008` wrote the grants for.
   */
  readonly databaseRole: string;
  readonly wallets: ReadonlySet<string>;
  readonly port: number;
  /**
   * Loopback by default, because the signer's designed audience is the decision plane.
   * A bind beyond loopback is legitimate behind a platform proxy and is refused unless a
   * delivery secret is configured, so the address that says *who may ask* and the seal
   * that says *what may be signed* are never one mechanism doing both jobs.
   */
  readonly host: string;
  /** Null means "no gate on this socket", which only a loopback bind may ask for. */
  readonly deliveryKey: string | null;
}

export function readConfig(env: NodeJS.ProcessEnv): SignerConfig {
  const secrets = env.TICKET_KEY ?? '';
  const databaseUrl = env.DATABASE_URL ?? '';
  const databaseRole = env.DATABASE_ROLE ?? 'ari_app';
  const deliverySecret = env.SIGNER_DELIVERY_KEY ?? '';
  const host = env.SIGNER_HOST ?? '127.0.0.1';
  const wallets = (env.SIGNER_WALLETS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const provider = env.SIGNING_PROVIDER ?? 'mock';

  const problems: string[] = [];
  if (secrets.length < 32) problems.push('TICKET_KEY must be at least 32 characters (openssl rand -base64 48)');
  if (databaseUrl.length === 0) {
    problems.push('DATABASE_URL is required: single use is a database fact, not a memory');
  } else {
    // This is the process that decides whether a ticket has been spent, so it is the one
    // whose database answer matters most — and a plaintext connection to a hosted
    // Postgres means whoever answers is not provably the database.
    const db = inspectDatabaseUrl(databaseUrl);
    if (db.problem !== null) problems.push(db.problem);
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseRole)) problems.push('DATABASE_ROLE must be a plain Postgres role name');
  if (wallets.length === 0) problems.push('SIGNER_WALLETS must name at least one wallet this signer holds capacity for');
  // Two rules, and the order between them is the point: setting the secret always turns
  // the gate on, so a deployment that configures one side only fails at startup rather
  // than discovering at first payment that the other side never sends it. A public bind
  // without any secret is refused outright.
  if (deliverySecret.length > 0 && deliverySecret.length < 32) {
    problems.push('SIGNER_DELIVERY_KEY must be at least 32 characters when set (openssl rand -base64 48)');
  }
  if (deliverySecret.length === 0 && !isLoopbackHost(host)) {
    problems.push(`SIGNER_DELIVERY_KEY is required when SIGNER_HOST=${host} binds beyond loopback: /v1/sign would answer anyone who finds it`);
  }
  if (provider !== 'mock') {
    // Phase 8 owns the Ika adapter, and `ASSUMPTIONS.md` §6 is still open. An
    // adapter written now would be a guess about a protocol whose source is on
    // this machine to read, and a guessed signature is indistinguishable from a
    // real one to everyone downstream.
    problems.push(`SIGNING_PROVIDER=${provider} is not implemented; the Ika adapter is Phase 8`);
  }
  if (problems.length > 0) throw new Error(`ari-signer cannot start:\n  - ${problems.join('\n  - ')}`);

  return {
    ticketKey: new TicketKey(secrets),
    databaseUrl,
    databaseRole,
    wallets: new Set(wallets),
    port: Number(env.SIGNER_PORT ?? env.PORT ?? '4100'),
    host,
    deliveryKey: deliverySecret.length === 0 ? null : deliverySecret,
  };
}

export interface RunningSigner {
  readonly deps: SignerDeps;
  readonly handle: ReturnType<typeof createSignHandler>;
  readonly provider: MockSigningProvider;
  close(): Promise<void>;
}

export async function startSigner(config: SignerConfig): Promise<RunningSigner> {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 8,
    // Applied by the backend before it answers the first query, so no pooled
    // connection is ever live under the wrong identity. Session-wide: this pool must
    // not sit behind a transaction-mode pooler.
    options: `-c role=${config.databaseRole}`,
  });
  pool.on('error', () => undefined);
  const probe = await pool.query<{ role: string }>(`SELECT current_user AS role`);
  if (probe.rows[0]?.role !== config.databaseRole) {
    await pool.end();
    throw new Error(`ari-signer cannot start:\n  - the connection reads as "${probe.rows[0]?.role ?? 'unknown'}", not "${config.databaseRole}"`);
  }
  const store: TicketStore = {
    redeem: (ticketId, digest, nowMs) => withTransaction(pool, (tx) => claimTicket(tx, ticketId, digest, nowMs)),
  };
  const provider = new MockSigningProvider();
  const deps: SignerDeps = {
    key: config.ticketKey,
    // A Postgres failure has to read as a refusal, not as an exception escaping
    // the request handler, so the store is wrapped rather than trusted.
    store: guardStore(store),
    provider,
    // The signer's own clock, deliberately: its expiry check is not the decision
    // plane's, and agreement between the two is what the boundary is for. Read per
    // attempt rather than per process — the type will not accept the other form.
    nowMs: () => BigInt(Date.now()),
    wallets: config.wallets,
  };

  const handle = createSignHandler({ sign: (request) => redeemAndSign(deps, request) });
  const server = createServer(createSignerRequestHandler({ handle, deliveryKey: config.deliveryKey }));
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

  return {
    deps,
    handle,
    provider,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    },
  };
}

/** Turns a thrown store into a spent ticket: fail closed, and fail quietly. */
export function guardStore(inner: TicketStore): TicketStore {
  return {
    async redeem(ticketId, digest, nowMs) {
      try {
        return await inner.redeem(ticketId, digest, nowMs);
      } catch {
        // The only safe reading of "we could not record this as spent" is "it was
        // spent". A store that cannot be written to cannot authorise a second
        // signature, and the alternative — signing anyway — is a double spend
        // dressed as an availability fix.
        return false;
      }
    },
  };
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  let config: SignerConfig;
  try {
    config = readConfig(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const signer = await startSigner(config);
  // Say what is enforced, not just where it listens: an operator reading this line at 3am
  // needs to know whether an unauthenticated caller could reach /v1/sign.
  console.log(
    `ari-signer listening on ${config.host}:${config.port}; provider=${signer.deps.provider.name}; delivery-gate=${config.deliveryKey === null ? 'off' : 'on'}`,
  );
  if (!isLoopbackHost(config.host)) {
    process.stderr.write(`ari-signer: bound to ${config.host}, reachable beyond this machine. TLS must terminate in front of it, and only the decision plane should hold its address.\n`);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void signer.close().then(() => process.exit(0));
    });
  }
}
