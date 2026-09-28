import { newId, type CanonicalDigest } from '@ari/schemas';
import { InMemoryTicketStore, type SignerOutcome } from '@ari/signing';
import { describe, expect, it } from 'vitest';
import { createSignHandler, responseFor } from '../src/handler.js';
import { guardStore, readConfig } from '../src/main.js';

const walletId = newId('wal');
const NOW = 1_761_400_030_000n;

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    TICKET_KEY: 'k'.repeat(48),
    DATABASE_URL: 'postgresql://ari:ari@127.0.0.1:5435/ari',
    SIGNER_WALLETS: walletId,
    SIGNING_PROVIDER: 'mock',
    ...overrides,
  };
}

describe('what ari-signer will refuse to start as', () => {
  it('refuses a sealing key that is too short to seal with', () => {
    expect(() => readConfig(env({ TICKET_KEY: 'changeme' }))).toThrow(/TICKET_KEY/);
  });

  it('refuses to run without a database, because single use is not a memory', () => {
    expect(() => readConfig(env({ DATABASE_URL: '' }))).toThrow(/DATABASE_URL is required/);
  });

  it('refuses a hosted database it would reach in plaintext', () => {
    // The default in node-postgres is no TLS, and a provider's connection string is
    // written to be pasted, not audited.
    expect(() => readConfig(env({ DATABASE_URL: 'postgresql://ari:ari@db.example.com/ari' }))).toThrow(/sslmode=verify-full/);
    expect(() => readConfig(env({ DATABASE_URL: 'postgresql://ari:ari@db.example.com/ari?sslmode=require' }))).toThrow(/scheduled to change/);
    expect(() => readConfig(env({ DATABASE_URL: 'postgresql://ari:ari@db.example.com/ari?sslmode=verify-full' }))).not.toThrow();
  });

  it('refuses to run holding no wallets, rather than signing nothing successfully', () => {
    expect(() => readConfig(env({ SIGNER_WALLETS: ' , ' }))).toThrow(/SIGNER_WALLETS/);
  });

  it('names Ika as unimplemented instead of falling back to a mock', () => {
    // The rule that matters at 3am in a deployment: a typo in provider config
    // must not silently produce signatures that mean nothing.
    expect(() => readConfig(env({ SIGNING_PROVIDER: 'ika' }))).toThrow(/not implemented; the Ika adapter is Phase 8/);
  });

  it('reports every problem at once', () => {
    let message = '';
    try {
      readConfig(env({ TICKET_KEY: '', DATABASE_URL: '' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('TICKET_KEY');
    expect(message).toContain('DATABASE_URL');
  });
});

describe('the delivery gate a signer may start with', () => {
  const key = 'delivery-secret-for-tests-0123456789abcdef';

  it('allows no gate on loopback, and reports it as absent rather than empty', () => {
    expect(readConfig(env()).deliveryKey).toBeNull();
  });

  it('enforces a gate that was configured, even where it is not required', () => {
    // Presence enforces: a deployment that set the secret on one side only fails at
    // startup, rather than discovering at first payment that the other side never sends.
    expect(readConfig(env({ SIGNER_DELIVERY_KEY: key })).deliveryKey).toBe(key);
  });

  it('refuses a public bind with no delivery secret', () => {
    expect(() => readConfig(env({ SIGNER_HOST: '0.0.0.0' }))).toThrow(
      /SIGNER_DELIVERY_KEY is required when SIGNER_HOST=0\.0\.0\.0 binds beyond loopback/,
    );
  });

  it('refuses a too-short secret rather than gating with it', () => {
    expect(() => readConfig(env({ SIGNER_DELIVERY_KEY: 'changeme' }))).toThrow(/SIGNER_DELIVERY_KEY must be at least 32 characters/);
  });

  it('names the missing gate beside every other problem, not instead of them', () => {
    let message = '';
    try {
      readConfig(env({ SIGNER_HOST: '0.0.0.0', TICKET_KEY: '', DATABASE_URL: '' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('TICKET_KEY');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('SIGNER_DELIVERY_KEY');
  });
});

describe('the request surface', () => {
  const signer = (outcome: SignerOutcome) =>
    createSignHandler({
      sign: async () => outcome,
    });

  it('refuses a body that is not two strings', async () => {
    for (const junk of [null, 'ticket', { ticket: 'x' }, { ticket: 1, canonical: 2 }]) {
      const response = await signer({ status: 'REJECTED', code: 'TICKET_INVALID', detail: 'unreachable' })(junk);
      expect(response.status).toBe(400);
    }
  });

  it('refuses an empty or oversized canonical blob before verifying anything', async () => {
    const handler = signer({ status: 'REJECTED', code: 'TICKET_INVALID', detail: 'unreachable' });
    expect((await handler({ ticket: 'a'.repeat(60), canonical: '' })).status).toBe(400);
    expect((await handler({ ticket: 'a'.repeat(60), canonical: 'x'.repeat(70 * 1024) })).status).toBe(400);
  });

  it('does not call the verifier for a request it rejected on shape', async () => {
    let called = 0;
    const handler = createSignHandler({
      sign: async () => {
        called += 1;
        return { status: 'REJECTED', code: 'TICKET_INVALID', detail: 'x' };
      },
    });
    await handler({ ticket: 42, canonical: 'ok' });
    expect(called).toBe(0);
  });

  it('answers a rejection with its reason code and no signature', async () => {
    const handler = signer({ status: 'REJECTED', code: 'TICKET_DIGEST_MISMATCH', detail: 'bytes differ' });
    const response = await handler({ ticket: 'a'.repeat(60), canonical: 'o{}' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ state: 'REJECTED', code: 'TICKET_DIGEST_MISMATCH', detail: 'bytes differ' });
  });

  it('returns the reconciliation ref and never the signature (S16)', () => {
    const response = responseFor({
      status: 'SIGNED',
      ticketId: newId('tkt'),
      digest: (`canon/v1:${'a'.repeat(64)}`) as CanonicalDigest,
      ref: { providerRef: 'mock-ref-1' },
      result: { state: 'COMPLETE', signature: 'SECRET-LOOKING-BYTES', trustworthy: false, provider: 'mock' },
    });
    expect(response.status).toBe(202);
    const body = JSON.stringify(response.body);
    // The assertion that matters is about the payload crossing the boundary, not
    // about whether a mock's "signature" looks real: whoever holds a signature can
    // broadcast it, so the response carries only the handle to ask about it.
    expect(body).not.toContain('SECRET-LOOKING-BYTES');
    expect(body).toContain('mock-ref-1');
  });

  it('reports a user_gated wallet as still waiting, not as signed', () => {
    const response = responseFor({
      status: 'AWAITING_USER_SHARE',
      ticketId: newId('tkt'),
      digest: (`canon/v1:${'a'.repeat(64)}`) as CanonicalDigest,
    });
    expect(response.status).toBe(202);
    expect(response.body.awaiting).toBe('USER_SHARE');
    expect(response.body.state).toBe('SIGNING_PENDING');
  });
});

describe('a store that cannot be written to', () => {
  it('treats "could not record this as spent" as "already spent"', async () => {
    const refusing: TicketStoreLike = {
      async redeem() {
        throw new Error('connection reset');
      },
    };
    const guarded = guardStore(refusing);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await guarded.redeem(newId('tkt'), (`canon/v1:${'a'.repeat(64)}`) as CanonicalDigest, NOW)).toBe(false);
    }
  });

  it('leaves a working store alone', async () => {
    const inner = new InMemoryTicketStore();
    const guarded = guardStore(inner);
    const digest = (`canon/v1:${'b'.repeat(64)}`) as CanonicalDigest;
    expect(await guarded.redeem(newId('tkt'), digest, NOW)).toBe(true);
    expect(inner.size).toBe(1);
  });
});

interface TicketStoreLike {
  redeem(ticketId: string, digest: CanonicalDigest, nowMs: bigint): Promise<boolean>;
}

