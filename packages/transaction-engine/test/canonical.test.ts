import { DIGEST_FIELD_ALLOWLIST, DELIBERATELY_NOT_IN_DIGEST } from '@ari/schemas';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_VERSION,
  canonicalEncode,
  canonicalize,
  computeDigest,
  verifyDigest,
} from '../src/index.js';
import {
  CTX,
  OTHER_RECIPIENT,
  UUID_A,
  UUID_B,
  candidateKeys,
  clone,
  contractCall,
  transfer,
  unknownTx,
} from './fixtures.js';

describe('canonicalEncode — the properties the module header claims', () => {
  it('is deterministic: the same value encodes to the same bytes twice', () => {
    expect(canonicalEncode(transfer())).toBe(canonicalEncode(transfer()));
  });

  it('ignores key insertion order', () => {
    const one = { b: 1n, a: 'x', c: { z: true, y: null } };
    const two = { c: { y: null, z: true }, a: 'x', b: 1n };
    expect(canonicalEncode(one)).toBe(canonicalEncode(two));
  });

  it('type-tags values, so a field changing JSON type changes its encoding', () => {
    // Without the tag, "10" and 10n encode identically — meaning a refactor that
    // turns a string field into a bigint keeps every historical digest while
    // changing what those digests commit to.
    expect(canonicalEncode('10')).not.toBe(canonicalEncode(10n));
    expect(canonicalEncode(10n)).toBe('b10');
    expect(canonicalEncode('10')).toBe('s2:10');
  });

  it('preserves bigints past 2^53, where a JSON number would have rounded', () => {
    const encoded = canonicalEncode({ raw: 18446744073709551615n });
    expect(encoded).toContain('b18446744073709551615');
    expect(encoded).not.toContain('18446744073709552000');
  });

  it('distinguishes null, undefined and absence', () => {
    expect(canonicalEncode({ a: null })).not.toBe(canonicalEncode({ a: undefined }));
    expect(canonicalEncode({ a: undefined })).not.toBe(canonicalEncode({}));
  });

  it('tags booleans in both directions, so false is not the same as absent', () => {
    expect(canonicalEncode(true)).toBe('d1');
    expect(canonicalEncode(false)).toBe('d0');
    expect(canonicalEncode({ ok: false })).not.toBe(canonicalEncode({}));
  });

  it('distinguishes an array from an object with numeric keys', () => {
    expect(canonicalEncode([1n, 2n])).not.toBe(canonicalEncode({ 0: 1n, 1: 2n }));
  });

  it('encodes bytes as a length-prefixed hex string', () => {
    expect(canonicalEncode(new Uint8Array([0xde, 0xad]))).toBe('y2:dead');
  });

  it('refuses a float rather than encoding it best-effort', () => {
    // The refusal is the feature: 4999.999999999 rounding against a $5,000 cap
    // decides whether money moves, and no rounding rule makes that defensible.
    expect(() => canonicalEncode({ amount: 5000.0 })).toThrow(TypeError);
    expect(() => canonicalEncode({ amount: 5000.0 })).toThrow(/float numbers are not encodable/);
  });

  it('refuses a function and a symbol', () => {
    expect(() => canonicalEncode(() => 1)).toThrow(TypeError);
    expect(() => canonicalEncode(Symbol('x'))).toThrow(TypeError);
  });
});

describe('canonicalize — field selection', () => {
  it('commits to every field the schema can produce, or names the exclusion', () => {
    // This is the test that fails when someone adds `memo` or `maxFeePerGas` to
    // a candidate and forgets the digest. An omitted field is a substitutable
    // field, so the omission has to be a decision recorded in the schema.
    const covered = new Set<string>([...DIGEST_FIELD_ALLOWLIST, ...DELIBERATELY_NOT_IN_DIGEST]);
    for (const variant of ['transfer', 'contract_call', 'unknown'] as const) {
      for (const key of candidateKeys(variant)) {
        expect(covered.has(key), `${variant}.${key} is neither digested nor excluded`).toBe(true);
      }
    }
  });

  it('never lists a field as both digested and excluded', () => {
    const overlap = DIGEST_FIELD_ALLOWLIST.filter((field) =>
      (DELIBERATELY_NOT_IN_DIGEST as readonly string[]).includes(field),
    );
    expect(overlap).toEqual([]);
  });

  it('excludes requestId and idempotencyKey on purpose, so a retry keeps its digest', () => {
    const original = transfer();
    const retry = transfer({
      requestId: `req_${UUID_B}`,
      idempotencyKey: 'inv-1-retry',
    });
    expect(canonicalize(retry, CTX)).toBe(canonicalize(original, CTX));
  });
});

describe('computeDigest — every substitution-critical field participates', () => {
  const mutations: Record<string, () => ReturnType<typeof transfer>> = {
    recipient: () => transfer({ recipient: { chain: 'ethereum', address: OTHER_RECIPIENT } }),
    amount: () => transfer({ amount: { raw: '2000000001', unit: 'usdc-6dp' } }),
    amountUnit: () => transfer({ amount: { raw: '2000000000', unit: 'wei' } }),
    chain: () => transfer({ chain: 'bitcoin' }),
    asset: () =>
      transfer({
        asset: { kind: 'native', chain: 'ethereum' },
      }),
    // Two USDCs are not one asset: contract address is asset identity.
    assetContract: () =>
      transfer({
        asset: {
          kind: 'erc20',
          chain: 'ethereum',
          contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          symbol: 'USDC',
          decimals: 6,
        },
      }),
    deadline: () => transfer({ deadline: '2026-09-26T12:00:00.000Z' }),
    wallet: () => transfer({ walletId: `wal_${UUID_B}` }),
    agent: () => transfer({ agentId: `agt_${UUID_B}` }),
    nonce: () =>
      transfer({
        replayProtection: {
          scheme: 'account_sequence',
          nonce: '13',
          chainId: '1',
          gasLimit: '21000',
          maxFeePerUnit: '20000000000',
          maxPriorityFeePerUnit: '1000000000',
        },
      }),
    chainId: () =>
      transfer({
        replayProtection: {
          scheme: 'account_sequence',
          nonce: '12',
          chainId: '11155111',
          gasLimit: '21000',
          maxFeePerUnit: '20000000000',
          maxPriorityFeePerUnit: '1000000000',
        },
      }),
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    it(`changes when ${name} changes`, () => {
      const base = computeDigest(transfer(), CTX);
      const changed = computeDigest(mutate(), CTX);
      expect(changed).not.toBe(base);
    });
  }

  it('binds the policy version, so an ALLOW under a looser version cannot be replayed under it', () => {
    const a = computeDigest(transfer(), { policyVersionId: `ppv_${UUID_A}` });
    const b = computeDigest(transfer(), {
      policyVersionId: 'ppv_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5d',
    });
    expect(a).not.toBe(b);
  });

  it('separates the three transaction kinds even when their money fields match', () => {
    const t = computeDigest(transfer(), CTX);
    const c = computeDigest(contractCall(), CTX);
    const u = computeDigest(unknownTx(), CTX);
    expect(new Set([t, c, u]).size).toBe(3);
  });

  it('digests an ERC-20 transfer, whose asset carries a decimal count', () => {
    // Regression: `decimals` was a JSON number, and numbers are unencodable by
    // design, so computeDigest threw for every erc20 candidate while passing
    // every test that only used native assets.
    const candidate = transfer();
    if (candidate.asset.kind !== 'erc20') throw new Error('fixture is no longer an erc20 transfer');
    expect(typeof candidate.asset.decimals).toBe('bigint');
    expect(() => computeDigest(candidate, CTX)).not.toThrow();
  });

  it('is stable across a deep clone: no object identity or key order leaks in', () => {
    expect(computeDigest(clone(transfer()), CTX)).toBe(computeDigest(transfer(), CTX));
  });

  it('carries its own algorithm version, so a future change cannot reinterpret old bytes', () => {
    const digest = computeDigest(transfer(), CTX);
    expect(digest.startsWith(`${CANONICAL_VERSION}:`)).toBe(true);
    expect(digest).toMatch(/^canon\/v1:[0-9a-f]{64}$/);
  });
});

describe('verifyDigest — the comparison the signer actually performs', () => {
  it('accepts the blob it was derived from', () => {
    const candidate = transfer();
    const digest = computeDigest(candidate, CTX);
    expect(verifyDigest(candidate, CTX, digest)).toBe(true);
  });

  it('rejects a recipient swapped after the digest was issued', () => {
    const approved = transfer();
    const digest = computeDigest(approved, CTX);
    const swapped = transfer({
      recipient: { chain: 'ethereum', address: OTHER_RECIPIENT },
    });
    expect(verifyDigest(swapped, CTX, digest)).toBe(false);
  });

  it('rejects the same bytes under a different policy version', () => {
    const digest = computeDigest(transfer(), { policyVersionId: `ppv_${UUID_A}` });
    expect(
      verifyDigest(transfer(), { policyVersionId: 'ppv_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5d' }, digest),
    ).toBe(false);
  });
});
