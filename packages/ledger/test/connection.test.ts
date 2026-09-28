/**
 * The connection-string rule, tested as a pure function. No database is involved: what is
 * under test is what the code decides *before* it opens a socket, which is the whole point
 * of putting the check there.
 */

import { describe, expect, it } from 'vitest';
import { inspectDatabaseUrl } from '../src/index.js';

const HOSTED = 'postgresql://ari:secret@ep-cool-water-1.us-east-2.aws.neon.tech/ari';

describe('a database that could be anywhere', () => {
  it('refuses the shape a provider hands you, which has no sslmode at all', () => {
    const facts = inspectDatabaseUrl(HOSTED);
    expect(facts.tls).toBe('absent');
    expect(facts.problem).toMatch(/plaintext/);
    expect(facts.problem).toMatch(/sslmode=verify-full/);
  });

  it('refuses no-verify, because an impostor answers row-security questions', () => {
    const facts = inspectDatabaseUrl(`${HOSTED}?sslmode=no-verify`);
    expect(facts.problem).toMatch(/impersonate/);
  });

  it('refuses disable', () => {
    expect(inspectDatabaseUrl(`${HOSTED}?sslmode=disable`).problem).toMatch(/unencrypted/);
  });

  it('refuses require, whose meaning is scheduled to change under us', () => {
    // Not pedantry: pg-connection-string 2.14 maps require/prefer/verify-ca to a verifying
    // socket and warns that v3 gives them libpq's weaker definitions. A control that passes
    // on `require` today passes on an unverified connection after a routine upgrade.
    for (const mode of ['require', 'prefer', 'verify-ca']) {
      const facts = inspectDatabaseUrl(`${HOSTED}?sslmode=${mode}`);
      expect(facts.tls).toBe('meaning-changes');
      expect(facts.problem).toMatch(/scheduled to change/);
    }
  });

  it('accepts the two spellings that verify, and reports no problem', () => {
    expect(inspectDatabaseUrl(`${HOSTED}?sslmode=verify-full`).problem).toBeNull();
    expect(inspectDatabaseUrl(`${HOSTED}?ssl=true`).problem).toBeNull();
  });

  it('lets sslmode win when both parameters are present', () => {
    // `?ssl=true&sslmode=disable` must not read as a verifying connection because the
    // friendlier-looking parameter came first.
    expect(inspectDatabaseUrl(`${HOSTED}?ssl=true&sslmode=disable`).problem).toMatch(/unencrypted/);
  });

  it('reads the host and port it is refusing', () => {
    const facts = inspectDatabaseUrl('postgresql://u:p@db.example.com:6432/ari');
    expect(facts.host).toBe('db.example.com');
    expect(facts.port).toBe(6432);
    expect(facts.problem).toMatch(/db\.example\.com/);
  });
});

describe('a database on this machine', () => {
  it('is exempt whatever it asks for, because the threat is the wire', () => {
    for (const url of [
      'postgresql://ari:ari@127.0.0.1:5435/ari',
      'postgresql://ari:ari@localhost/ari?sslmode=disable',
      'postgresql://ari:ari@[::1]:5432/ari',
    ]) {
      expect(inspectDatabaseUrl(url).problem).toBeNull();
    }
  });

  it('does not mistake a wildcard bind for loopback', () => {
    expect(inspectDatabaseUrl('postgresql://ari:ari@0.0.0.0:5435/ari').problem).not.toBeNull();
  });
});

describe('what cannot be connected to at all', () => {
  it('names an empty URL as missing rather than unparseable', () => {
    expect(inspectDatabaseUrl('').problem).toMatch(/required/);
  });

  it('names a string that is not a URL', () => {
    expect(inspectDatabaseUrl('not-a-connection-string').problem).toMatch(/parseable/);
  });
});
