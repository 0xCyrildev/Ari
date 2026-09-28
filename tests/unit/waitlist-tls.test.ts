/**
 * The waitlist's TLS rule, and the drift guard over it.
 *
 * `apps/web` sits outside the pnpm workspace on purpose, so its copy of this decision
 * cannot import the authoritative one in `@ari/ledger`. Two independent security rules is
 * how one ends up weaker than the other while every suite stays green, so this file asserts
 * agreement over a corpus instead: if either predicate starts to disagree about a URL, this
 * test names the URL.
 */

import { inspectDatabaseUrl } from '@ari/ledger';
import { describe, expect, it } from 'vitest';
import { waitlistUrlIsSafe } from '../../apps/web/lib/db/tls.js';

const HOSTS = ['db.example.com', 'ep-quiet-forest-1.aws.neon.tech', '127.0.0.1', 'localhost', '[::1]', '0.0.0.0'];
const SUFFIXES = [
  '',
  '?sslmode=verify-full',
  '?sslmode=require',
  '?sslmode=verify-ca',
  '?sslmode=prefer',
  '?sslmode=no-verify',
  '?sslmode=disable',
  '?sslmode=bogus',
  '?ssl=true',
  '?ssl=false',
  '?ssl=true&sslmode=disable',
];

describe('the two copies of the rule decide alike', () => {
  it('over every host and every ssl spelling this repository recognises', () => {
    for (const host of HOSTS) {
      for (const suffix of SUFFIXES) {
        const url = `postgresql://ari:secret@${host}/ari${suffix}`;
        const ledgerSaysSafe = inspectDatabaseUrl(url).problem === null;
        expect(waitlistUrlIsSafe(url), url).toBe(ledgerSaysSafe);
      }
    }
  });

  it('and both refuse the string a provider hands you', () => {
    // No sslmode at all: node-postgres connects in plaintext, and this is the shape of a
    // copy-pasted connection string.
    const pasted = 'postgresql://ari:secret@ep-quiet-forest-1.aws.neon.tech/ari';
    expect(waitlistUrlIsSafe(pasted)).toBe(false);
    expect(inspectDatabaseUrl(pasted).problem).toMatch(/plaintext/);
  });
});

describe('what the waitlist accepts', () => {
  it('a verifying connection, and a local one', () => {
    expect(waitlistUrlIsSafe('postgresql://ari:s@db.example.com/ari?sslmode=verify-full')).toBe(true);
    expect(waitlistUrlIsSafe('postgresql://ari:s@127.0.0.1:5435/waitlist')).toBe(true);
  });

  it('nothing it cannot parse', () => {
    expect(waitlistUrlIsSafe('')).toBe(false);
    expect(waitlistUrlIsSafe('not a url')).toBe(false);
  });
});
