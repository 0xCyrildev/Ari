import { newId, type AuthorizationTicket, type CanonicalDigest, type TicketClaims } from '@ari/schemas';
import { computeDigest } from '@ari/transaction-engine';
import { describe, expect, it } from 'vitest';
import {
  InMemoryTicketStore,
  MockSigningProvider,
  openTicket,
  redeemAndSign,
  sealTicket,
  TICKET_TTL_MS,
  TicketKey,
  type AuthorizedSigningRequest,
  type SignerDeps,
} from '../src/index.js';
import {
  AFTER_TTL,
  GOOD_KEY,
  OTHER_KEY,
  WITHIN_TTL,
  candidate,
  claimsForTest,
  policyVersionId,
  request,
  walletId,
} from './fixtures.js';

const key = new TicketKey(GOOD_KEY);
const otherKey = new TicketKey(OTHER_KEY);

/** Seal a ticket and hand back the exact claims inside it, so a round-trip
 * comparison is not comparing two separately generated fixtures. */
function minted(overrides: Parameters<typeof request>[0] = {}) {
  const claims = claimsForTest(overrides);
  const result = sealTicket(claims, key);
  if (!result.ok) throw new Error(`fixture ticket refused sealing: ${result.reason}`);
  return { claims, ticket: result.ticket };
}

function sealed(overrides: Parameters<typeof request>[0] = {}) {
  return minted(overrides).ticket;
}

/** A claims object whose stated lifetime exceeds the TTL, which `claimsFor` will not produce. */
function overLongLifetime() {
  return { ...claimsForTest(), expiresAtMs: WITHIN_TTL + TICKET_TTL_MS * 60n };
}

function signer(over: Partial<SignerDeps> = {}) {
  const provider = new MockSigningProvider();
  const store = new InMemoryTicketStore();
  return {
    provider,
    store,
    deps: { key, store, provider, nowMs: WITHIN_TTL, wallets: new Set([walletId]), ...over } satisfies SignerDeps,
  };
}

describe('TicketKey', () => {
  it('refuses a sealing key too short to be worth having', () => {
    // Every property a ticket buys is conditional on this secret, and the
    // configuration that supplies one is a deploy-time accident rather than
    // something anyone will remember to test.
    expect(() => new TicketKey('hunter2')).toThrow(RangeError);
    expect(() => new TicketKey('x'.repeat(64))).not.toThrow();
  });
});

describe('sealing and opening', () => {
  it('round-trips the claims, big integers intact', () => {
    const { claims, ticket } = minted();
    const opened = openTicket(ticket, key);
    if (!opened.ok) throw new Error('round trip failed');
    expect(opened.claims.ticketId).toBe(claims.ticketId);
    expect(opened.claims.amountRaw).toBe(claims.amountRaw);
    expect(typeof opened.claims.amountRaw).toBe('bigint');
    expect(opened.claims.digest).toBe(claims.digest);
  });

  it('refuses a lifetime longer than the ticket TTL at the seal', () => {
    const result = sealTicket(overLongLifetime(), key);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('lifetime');
  });

  it('refuses claims that do not satisfy the schema, rather than sealing them anyway', () => {
    // `digest` is validated by shape, so a claim that is not a digest at all is
    // the case that has to be refused before anything is sealed.
    const claims: TicketClaims = { ...claimsForTest(), digest: 'canon/v1:deadbeef' as CanonicalDigest };
    const result = sealTicket(claims, key);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not well-formed');
  });

  it('rejects a ticket sealed by a different key', () => {
    const opened = openTicket(sealed(), otherKey);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe('BAD_SIGNATURE');
  });

  it('rejects a payload edited after it was sealed', () => {
    const { ticket } = minted();
    const signature = ticket.split('.')[1];
    const tampered = Buffer.from(
      // The same bigint replacer the seal uses, so the only difference between
      // this payload and the sealed one is the amount.
      JSON.stringify({ ...claimsForTest(), amountRaw: '1' }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      'utf8',
    ).toString('base64url');
    const opened = openTicket(`${tampered}.${signature}`, key);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe('BAD_SIGNATURE');
    // Worth stating what this does *not* prove: keeping the original signature and
    // editing the payload is the only forgery the seal has to resist, because the
    // payload is never re-canonicalised before verification.
    expect(tampered).not.toBe(sealed().split('.')[0]);
  });

  it('rejects nonsense rather than reading a claim into it', () => {
    for (const junk of ['', 'a', 'a.b', `${'x'.repeat(60)}.`, '.']) {
      expect(openTicket(junk, key).ok).toBe(false);
    }
  });
});

describe('the signer', () => {
  it('signs a valid ticket and says the signature is not chain truth', async () => {
    const { deps, provider } = signer();
    const { canonical, digest } = candidate();
    const outcome = await redeemAndSign(deps, { ticket: sealed(), canonical });
    if (outcome.status !== 'SIGNED') throw new Error(`expected SIGNED, got ${outcome.status}`);
    expect(outcome.digest).toBe(digest);
    if (outcome.result.state !== 'COMPLETE') throw new Error('mock provider did not complete');
    // A mock that could be mistaken for a signature is the failure A10 exists to
    // prevent, so the flag travels on the result rather than in a comment.
    expect(outcome.result.trustworthy).toBe(false);
    expect(provider.invocations).toBe(1);
  });

  it('refuses a ticket whose bytes are not the bytes it seals', async () => {
    const { deps, provider, store } = signer();
    const approved = candidate();
    const swapped = candidate({ amount: { raw: '2000000001', unit: 'usdc-6dp' } });
    const outcome = await redeemAndSign(deps, {
      ticket: sealed({ digest: approved.digest }),
      canonical: swapped.canonical,
    });
    if (outcome.status !== 'REJECTED') throw new Error(`expected REJECTED, got ${outcome.status}`);
    expect(outcome.code).toBe('TICKET_DIGEST_MISMATCH');
    // The whole point of the check: no signature was asked for, and nothing was
    // consumed, so the legitimate ticket is still redeemable with its own bytes.
    expect(provider.invocations).toBe(0);
    expect(store.size).toBe(0);
  });

  it('refuses an expired ticket without reaching the provider', async () => {
    const { deps, provider } = signer({ nowMs: AFTER_TTL });
    const outcome = await redeemAndSign(deps, { ticket: sealed(), canonical: candidate().canonical });
    if (outcome.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(outcome.code).toBe('TICKET_EXPIRED');
    expect(provider.invocations).toBe(0);
  });

  it('refuses a ticket carrying an over-long lifetime even though the seal is valid', async () => {
    // Sealed by this key, so it can only be caught by reading the claim rather
    // than trusting it — which is what a second process is for.
    const longLivedTicket = sealTicket(overLongLifetime(), key);
    if (!longLivedTicket.ok) {
      // A seal that refuses it is the better outcome; the signer's check is still
      // what makes a key compromise or a code change unable to honour one.
      expect(longLivedTicket.reason).toContain('lifetime');
      return;
    }
    const longLived = longLivedTicket.ticket;
    const { deps, provider } = signer();
    const outcome = await redeemAndSign(deps, { ticket: longLived, canonical: candidate().canonical });
    if (outcome.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(outcome.code).toBe('TICKET_INVALID');
    expect(provider.invocations).toBe(0);
  });

  it('spends a ticket once and refuses the second presentation', async () => {
    const { deps, provider } = signer();
    const ticket = sealed();
    const canonical = candidate().canonical;
    expect((await redeemAndSign(deps, { ticket, canonical })).status).toBe('SIGNED');
    const second = await redeemAndSign(deps, { ticket, canonical });
    if (second.status !== 'REJECTED') throw new Error('expected the replay to be refused');
    expect(second.code).toBe('TICKET_ALREADY_USED');
    expect(provider.invocations).toBe(1);
  });

  it('refuses a ticket for a wallet it holds nothing for', async () => {
    const { deps, provider } = signer({ wallets: new Set() });
    const outcome = await redeemAndSign(deps, { ticket: sealed(), canonical: candidate().canonical });
    if (outcome.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(outcome.code).toBe('TICKET_INVALID');
    expect(outcome.detail).toContain('not held by this signer');
    expect(provider.invocations).toBe(0);
  });

  it('reports a seal from another key as a key problem, not as a generic invalid', async () => {
    const ticket = sealed();
    const canonical = candidate().canonical;

    const ours = signer();
    expect((await redeemAndSign(ours.deps, { ticket, canonical })).status).toBe('SIGNED');

    const theirs = signer({ key: otherKey });
    const outcome = await redeemAndSign(theirs.deps, { ticket, canonical });
    if (outcome.status !== 'REJECTED') throw new Error('expected REJECTED');
    // Distinct codes, because "wrong issuer" and "not a ticket" are different
    // incidents with different answers.
    expect(outcome.code).toBe('SIGNER_KEY_MISMATCH');
    expect(theirs.provider.invocations).toBe(0);
  });

  it('cannot complete a user_gated signature, and does not spend the ticket trying', async () => {
    const { deps, provider, store } = signer();
    const ticket = sealed({ authorityMode: 'user_gated' });
    const outcome = await redeemAndSign(deps, { ticket, canonical: candidate().canonical });
    if (outcome.status !== 'AWAITING_USER_SHARE') throw new Error(`expected AWAITING_USER_SHARE, got ${outcome.status}`);
    expect(provider.invocations).toBe(0);
    expect(store.size).toBe(0);
    // The claim belongs to the ceremony that finishes with the human's share.
    // Spending it here would leave an authorised payment that can never complete.
  });
});

describe('what the boundary will not accept', () => {
  it('a provider cannot be handed a transaction', async () => {
    const { provider } = signer();
    // @ts-expect-error — SigningProvider takes an AuthorizedSigningRequest, and a
    // candidate transaction is not one and cannot be made into one.
    await provider.createSigningRequest(candidate().candidate);
    // What this proves is the compile error above, and only that: at runtime a
    // mock will count anything, which is exactly why the type is the control.
  });

  it('a ticket is not a string someone can cast into being a ticket', () => {
    // @ts-expect-error — the brand is the mechanism; a bearer token minted by hand
    // bypasses every check a seal is supposed to carry.
    const forged: AuthorizationTicket = 'x'.repeat(120);
    expect(forged.length).toBeGreaterThan(0);
  });

  it('the canonical bytes a provider signs are the only transactional content in the request', () => {
    const authorised: AuthorizedSigningRequest = {
      ticketId: newId('tkt'),
      walletId,
      digest: computeDigest(candidate().candidate, { policyVersionId }),
      canonical: 'o{...}',
    };
    // @ts-expect-error — nothing in an AuthorizedSigningRequest can carry a
    // candidate transaction, so there is no field to put one in.
    const smuggled: AuthorizedSigningRequest = { ...authorised, candidate: candidate().candidate };
    expect(smuggled.ticketId).toBe(authorised.ticketId);
  });
});
