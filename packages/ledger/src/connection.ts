/**
 * Whether a database connection is safe to make, decided from the URL before any socket
 * opens.
 *
 * Every `DATABASE_URL` this repository has ever seen pointed at `127.0.0.1`, where
 * encryption is a matter of taste. A hosted Postgres makes the same string mean something
 * else: `node-postgres` defaults to **no TLS at all** when the URL omits `sslmode`, which
 * is exactly what a provider's copy-to-clipboard connection string looks like. The service
 * would then start cleanly, answer its health check, enforce row security correctly, and
 * carry the login, the peppered credential lookups and every payment row across the
 * internet in plaintext. Nothing downstream would notice.
 *
 * So the rule is stated where the connection is made, and it refuses rather than warns —
 * the same shape as `DATABASE_ROLE`, which also exists because a silently-wrong database
 * identity is the one failure that reads as working.
 */

import { isLoopbackHost } from '@ari/schemas';

/**
 * What the URL asks for, in security terms rather than in libpq's vocabulary — because
 * libpq's vocabulary is the problem: `pg-connection-string` 2.14 maps `require`, `prefer`
 * and `allow` all to a *verifying* socket today and prints a warning that v3.0.0 (with
 * `pg` 9) will give them libpq's weaker meanings. A control that passes on `require`
 * therefore passes today and silently stops being a control in a dependency bump.
 */
export type DatabaseTls = 'verify-full' | 'ssl-true' | 'absent' | 'plaintext' | 'unverified' | 'meaning-changes';

export interface DatabaseUrlFacts {
  readonly host: string;
  readonly port: number;
  readonly tls: DatabaseTls;
  /** The raw `sslmode`, so a refusal can name what was actually written. */
  readonly sslmode: string | null;
  /** Null when the connection may be made: verifying TLS, or an address that cannot leave this machine. */
  readonly problem: string | null;
}

const VERIFYING = new Set(['verify-full']);
const PLAINTEXT_CAPABLE = new Set(['disable', 'allow']);
const NO_HOSTNAME_CHECK = new Set(['no-verify']);
const WEAK_IN_LIBPQ = new Set(['require', 'prefer', 'verify-ca']);

function classify(sslmode: string): DatabaseTls {
  if (VERIFYING.has(sslmode)) return 'verify-full';
  if (NO_HOSTNAME_CHECK.has(sslmode)) return 'unverified';
  if (PLAINTEXT_CAPABLE.has(sslmode)) return 'plaintext';
  if (WEAK_IN_LIBPQ.has(sslmode)) return 'meaning-changes';
  // An sslmode this code does not recognise is not something to guess about.
  return 'plaintext';
}

function refusal(facts: Pick<DatabaseUrlFacts, 'host' | 'tls' | 'sslmode'>): string {
  const where = `the database at ${facts.host}`;
  switch (facts.tls) {
    case 'absent':
      return `DATABASE_URL names ${where} with no sslmode, and node-postgres then connects in plaintext. Append ?sslmode=verify-full.`;
    case 'meaning-changes':
      return `sslmode=${facts.sslmode} verifies the certificate with pg 8 today, and pg-connection-string v3 / pg v9 will give it libpq's weaker meaning — encryption without the hostname, or plaintext when the server prefers it. Do not build a control on a word whose definition is scheduled to change: use sslmode=verify-full.`;
    case 'unverified':
      return `sslmode=${facts.sslmode} encrypts without checking who is at the other end. Anyone able to impersonate ${where} then gets to answer row-security questions for a payment system: use sslmode=verify-full.`;
    default:
      return `sslmode=${facts.sslmode ?? 'false'} permits an unencrypted connection to ${where}: use sslmode=verify-full.`;
  }
}

/** What the server's own view of the socket said, and what address it saw us from. */
export interface TlsObservation {
  /** `pg_stat_ssl.ssl` for our backend pid. */
  readonly serverReportsSsl: boolean;
  /** `inet_client_addr()` as the server sees it — a proxy shows up as a private address. */
  readonly seenClientAddr: string | null;
}

const PRIVATE_OR_LINK_LOCAL = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|fd[0-9a-f]{2}:|::1)/i;

/**
 * Judge the encryption of a connection we have already made.
 *
 * `pg_stat_ssl` describes the socket from the **server's** side, and on a managed provider
 * that is not the socket we opened: Neon, Supabase and anything else with a proxy terminate
 * TLS at their edge and connect the backend over a private address, so the query answers
 * `ssl=false` for a connection that is verified end to end from here. Reading that as a
 * failure would condemn every hosted Postgres on the basis of the provider's own topology.
 *
 * What actually proves the client-side hop is the handshake: `sslmode=verify-full` fails
 * closed on a missing, expired or mismatched certificate, so a connection that *succeeded*
 * under it was verified. The server's view is corroborating detail, and it only contradicts
 * that when it claims no TLS while seeing us from a public address — a case worth naming
 * rather than swallowing.
 */
export function tlsVerdict(requested: DatabaseTls, loopback: boolean, observed: TlsObservation): { status: 'pass' | 'warn' | 'fail'; detail: string } {
  const verifiedFromHere = requested === 'verify-full' || requested === 'ssl-true';

  if (observed.serverReportsSsl) {
    return { status: 'pass', detail: 'TLS on the socket the server sees' };
  }
  if (verifiedFromHere) {
    const where = observed.seenClientAddr === null ? 'an unknown address' : observed.seenClientAddr;
    if (observed.seenClientAddr !== null && !PRIVATE_OR_LINK_LOCAL.test(observed.seenClientAddr)) {
      return { status: 'warn', detail: `verified from here, but the server sees no TLS and sees us from the public address ${where} — not the private hop a proxy would use` };
    }
    return { status: 'pass', detail: `verified from here (sslmode=${requested === 'ssl-true' ? 'true' : 'verify-full'} fails closed on a bad certificate); the server sees the provider's proxy at ${where}, which is why its own row says ssl=false` };
  }
  if (loopback) {
    return { status: 'pass', detail: 'plaintext on loopback, which is what the development compose is' };
  }
  return { status: 'fail', detail: 'the server accepted the connection without TLS, and nothing verified the peer' };
}

/**
 * Read a connection string as a security decision.
 *
 * Loopback is exempt because the threat is the wire, not the socket: a local Postgres in
 * the development compose is where every suite here runs, and refusing it would teach
 * people to set an override before they ever reached production.
 */
export function inspectDatabaseUrl(url: string): DatabaseUrlFacts {
  const empty = { host: '', port: 0, tls: 'absent' as DatabaseTls, sslmode: null };
  if (url.trim().length === 0) {
    return { ...empty, problem: 'DATABASE_URL is required' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...empty, problem: 'DATABASE_URL is not a parseable postgres URL' };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port.length > 0 ? parsed.port : '5432');
  const sslmode = parsed.searchParams.get('sslmode')?.toLowerCase() ?? null;
  const ssl = parsed.searchParams.get('ssl')?.toLowerCase() ?? null;

  // `sslmode` wins when both are present, which is what node-postgres does; saying it
  // here keeps `?ssl=true&sslmode=disable` from reading as a verifying connection.
  let tls: DatabaseTls;
  if (sslmode !== null) {
    tls = classify(sslmode);
  } else if (ssl === 'true' || ssl === '1') {
    // A boolean `ssl` gives node-postgres `{}`, which verifies the chain and the hostname.
    tls = 'ssl-true';
  } else {
    tls = 'absent';
  }

  const safe = isLoopbackHost(host) || tls === 'verify-full' || tls === 'ssl-true';
  return { host, port, tls, sslmode, problem: safe ? null : refusal({ host, tls, sslmode }) };
}

/** Half a second: long enough to cross a region and open a connection, short enough that a
 *  health check never becomes the reason a platform thinks this process is hung. */
export const HEALTH_PROBE_TIMEOUT_MS = 500;

/**
 * Can this pool still answer, right now — as one bounded call both services share.
 *
 * It lives here rather than in each `main`, because the two processes must not be able to
 * disagree about what "healthy" means: a signer reporting `ok` while the plane that feeds
 * it reports `degraded` is two health checks rather than one fact.
 *
 * The timeout is a race, not a cancellation — `pg` has no way to abandon a queued
 * statement — so the timer is cleared on the fast path. Leaving it would hold the event
 * loop open for half a second after every probe, which is exactly the delay that turns a
 * graceful shutdown into a killed one.
 */
export async function probeDatabase(
  pool: { query(sql: string): Promise<unknown> },
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<'ok' | 'unavailable'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = pool.query('SELECT 1').then(
    () => 'ok' as const,
    // A refusal is an answer, and it is this one: the statement could not be run. The
    // rejection is handled here, so a dead database cannot produce an unhandled
    // rejection that kills the process while it is trying to report that it is sick.
    () => 'unavailable' as const,
  );
  const answer = await Promise.race([
    probe,
    new Promise<'unavailable'>((resolve) => {
      timer = setTimeout(() => resolve('unavailable'), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return answer;
}
