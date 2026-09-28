/**
 * `ari-api`'s startup refusals. There were none before tonight, which is how a process
 * that claims to refuse-permissive-configuration managed to have no test that it does:
 * every suite that calls `readConfig` calls it with a valid environment, because it needs
 * a config to run.
 */

import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/server.js';

const LOCAL = 'postgresql://ari:ari@127.0.0.1:5435/ari';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: LOCAL,
    CREDENTIAL_PEPPER: 'api-config-pepper-0123456789abcdef0123',
    TICKET_KEY: 't'.repeat(48),
    APPROVAL_KEY: 'a'.repeat(48),
    ORG_BOOTSTRAP_TOKEN: 'bootstrap-token-for-tests',
    ...overrides,
  };
}

describe('what ari-api refuses to start as', () => {
  it('accepts the local development database exactly as written', () => {
    expect(readConfig(env()).databaseUrl).toBe(LOCAL);
  });

  it('refuses a hosted database it would reach in plaintext', () => {
    expect(() => readConfig(env({ DATABASE_URL: 'postgresql://ari:pw@db.example.com/ari' }))).toThrow(/plaintext/);
  });

  it('refuses the sslmodes whose definition is scheduled to change under a dependency bump', () => {
    expect(() => readConfig(env({ DATABASE_URL: 'postgresql://ari:pw@db.example.com/ari?sslmode=require' }))).toThrow(
      /scheduled to change/,
    );
  });

  it('accepts a verifying connection to the same host', () => {
    expect(readConfig(env({ DATABASE_URL: 'postgresql://ari:pw@db.example.com/ari?sslmode=verify-full' })).databaseUrl).toContain(
      'db.example.com',
    );
  });

  it('refuses a signer beyond loopback with no delivery credential of its own', () => {
    expect(() => readConfig(env({ SIGNER_URL: 'https://ari-signer.pxxl.space.cv/v1/sign' }))).toThrow(
      /SIGNER_DELIVERY_KEY is required when SIGNER_URL points beyond loopback/,
    );
    // …and the same URL with a key is a configuration, not a warning.
    expect(
      readConfig({ ...env(), SIGNER_URL: 'https://ari-signer.pxxl.space.cv/v1/sign', SIGNER_DELIVERY_KEY: 'k'.repeat(48) })
        .signerDeliveryKey,
    ).toBe('k'.repeat(48));
  });

  it('reports every problem at once, so one boot names the whole list', () => {
    let message = '';
    try {
      readConfig(env({ DATABASE_URL: 'postgresql://ari:pw@db.example.com/ari', TICKET_KEY: '', ORG_BOOTSTRAP_TOKEN: 'x' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('TICKET_KEY');
    expect(message).toContain('ORG_BOOTSTRAP_TOKEN');
    expect(message).toContain('sslmode=verify-full');
  });
});
