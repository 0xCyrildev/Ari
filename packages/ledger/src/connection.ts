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
