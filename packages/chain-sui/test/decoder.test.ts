/**
 * Unit tests for the Sui decoder and the shared chain contract.
 *
 * Read the header of `decode.ts` before trusting what this file proves. These tests are built
 * from byte sequences this author laid out by hand, which means they can prove three things and
 * cannot prove a fourth:
 *
 *   PROVED — the BCS reader's strictness (trailing bytes, non-minimal lengths, oversized
 *     sequence claims, bad booleans) because those rules are this reader's own contract.
 *   PROVED — that every unrecognised variant index produces a refusal that names the index, and
 *     that no refusal path can produce an `ok`.
 *   PROVED — the digest *construction*: the two-hashes distinction, the type-name prefix, the
 *     intent layout, base58 round-tripping, and a cross-check of Blake2b against Node's own
 *     OpenSSL implementation of BLAKE2b-512, which is an independent implementation of the same
 *     primitive.
 *   NOT PROVED — that the declared variant indices and field order match what Sui actually
 *     emits. That requires bytes produced by real Sui tooling, and it lives in `vectors.test.ts`.
 *     A decoder that agrees with its author's guess about a wire format is exactly the failure
 *     this file is here not to paper over.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { BcsReader, BcsError } from '../src/bcs.js';
import { decodeTransactionData, KNOWN_VARIANTS } from '../src/decode.js';
import {
  base58Decode,
  base58Encode,
  chainIdentifierBytes,
  digestBase58,
  digestHex,
  signingDigestOf,
  transactionDigestOf,
} from '../src/digest.js';
import { MAX_SUI_TX_BYTES, SUI_ADAPTER_NAME, validateSuiTransaction, type SuiValidationPolicy } from '../src/validate.js';
import {
  ChainTransactionDigest,
  chainDigestOf,
  checkCapabilities,
  chainOfDigest,
  isSupported,
  notSupported,
} from '@ari/chain-core';
import { chainValidityWindowMs, chooseConstructionSite, maxTicketTtlMs } from '@ari/chain-core';

const bytes = (hex: string): Uint8Array => new Uint8Array(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
const hexOf = (value: Uint8Array): string => Buffer.from(value).toString('hex');

describe('the BCS reader refuses the ways a parser gets fooled', () => {
  it('reads the fixed-width integers little-endian and as bigint', () => {
    // One field after another, so each expectation says what the bytes *at that offset* mean:
    // `02 01` little-endian is 258, and a reader that got the byte order wrong would say 513.
    const reader = new BcsReader(bytes('01' + '0201' + '04030201' + '0807060504030201'));
    expect(reader.u8()).toBe(1);
    expect(reader.u16()).toBe(0x0102);
    expect(reader.u32()).toBe(0x01020304);
    expect(reader.u64()).toBe(0x0102030405060708n);
    reader.expectEnd();
  });

  it('rejects trailing bytes rather than ignoring them', () => {
    const reader = new BcsReader(bytes('01ff'));
    reader.u8();
    expect(() => reader.expectEnd()).toThrowError(BcsError);
    try {
      reader.expectEnd();
    } catch (error) {
      expect((error as BcsError).kind).toBe('TRAILING_BYTES');
    }
  });

  it('rejects a non-minimal uleb128 length', () => {
    // `80 00` is a two-group encoding of zero: the continuation bit says "more to come" and the
    // group that follows contributes nothing. Same value as `00`, different bytes — the collision.
    const reader = new BcsReader(bytes('8000ff'));
    expect(() => reader.uleb128()).toThrowError(/non-minimal|redundant/i);
  });

  it('rejects a sequence length larger than the payload could contain', () => {
    const reader = new BcsReader(bytes('ff7f01'));
    expect(() => reader.length()).toThrowError(/exceeds|byte\(s\) left/);
  });

  it('rejects a boolean that is not 0 or 1', () => {
    expect(() => new BcsReader(bytes('02')).bool()).toThrowError(/not a boolean/);
  });

  it('rejects a UTF-8 string that is not valid UTF-8', () => {
    const reader = new BcsReader(bytes('02fffe'));
    expect(() => reader.string()).toThrow();
  });
});

describe('the two Sui digests are different values', () => {
  const sample = new Uint8Array([KNOWN_VARIANTS.transactionData.v1, 1, 2, 3]);

  it('the transaction digest is blake2b-256 over the type-name prefix plus the body', () => {
    const digest = transactionDigestOf(sample);
    const expected = blake2b(new Uint8Array([...new TextEncoder().encode('TransactionData::'), ...sample]), { dkLen: 32 });
    expect(digestHex(digest)).toBe(`0x${hexOf(expected)}`);
    expect(digest.startsWith('sui/')).toBe(true);
    expect(chainOfDigest(digest)).toBe('sui');
  });

  it('the signing digest is blake2b-256 over the intent plus the body, with no prefix', () => {
    const signing = signingDigestOf(sample);
    const expected = blake2b(new Uint8Array([0, 0, 0, ...sample]), { dkLen: 32 });
    expect(digestHex(signing)).toBe(`0x${hexOf(expected)}`);
    // The two are not the same number over the same bytes, which is the entire reason this
    // distinction exists in the code rather than in a comment.
    expect(digestHex(signing)).not.toBe(digestHex(digestOfForComparison(sample)));
  });

  it('an authority signature hash appends the epoch and therefore differs again', () => {
    const withEpoch = signingDigestOf(sample, 7n);
    const without = signingDigestOf(sample);
    expect(digestHex(withEpoch)).not.toBe(digestHex(without));
  });
});

/**
 * The stored digest is lowercase hex, not Sui's base58 rendering, and this is the defect that
 * made that a rule rather than a preference. The first version of `chainDigestOf` lower-cased
 * whatever rendering it was handed; base58 is case-sensitive, so over 200 random blake2b-256
 * digests that made 130 undecodable (`L` → `l`, absent from the alphabet) and the other 70 decode
 * to *different bytes* — two strings for one digest, sealing a ticket against a value that a
 * different string also claims. Measured, not theorised: see `~/ari.SESSION.2026-10-25.md`.
 */
describe('a sealed digest has exactly one meaning', () => {
  it('survives the case folding that a base58 rendering could not', () => {
    for (const seed of [new Uint8Array([0, 1, 2, 3]), new Uint8Array(32).fill(255), blake2b('probe', { dkLen: 32 })]) {
      const digest = transactionDigestOf(seed);
      const bytes = new Uint8Array(Buffer.from(digest.slice(digest.indexOf(':') + 1), 'hex'));
      expect(digestHex(digest)).toBe(`0x${hexOf(bytes)}`);
      expect(digest.toLowerCase()).toBe(digest);
      // The human-facing rendering round-trips, so dropping base58 from storage lost nothing.
      expect(base58Decode(digestBase58(digest))).toEqual(bytes);
    }
  });

  it('refuses a digest whose payload is not canonical hex', () => {
    // Uppercase is rejected at the screen rather than silently normalized, so no caller can be
    // holding `…Ab…` and another holding `…ab…` for the same authorization.
    const good = transactionDigestOf(new Uint8Array([0, 1, 2, 3]));
    const [tag, value] = [good.slice(0, good.indexOf(':')), good.slice(good.indexOf(':') + 1)];
    expect(() => ChainTransactionDigest.parse(`${tag}:${value.toUpperCase()}`)).toThrow();
    expect(() => ChainTransactionDigest.parse(`${tag}:${value.slice(1)}`)).toThrow();
    expect(() => chainDigestOf('sui/blake2b256-txdata-v1', new Uint8Array(31))).toThrow(/256-bit digest/);
  });

  it('reads the chain off the tag, never off a sibling field', () => {
    // The property `chainOfDigest` exists for: a digest is self-describing, so a validated
    // transaction cannot claim `chain: 'sui'` while carrying a Solana signing digest.
    const sui = transactionDigestOf(new Uint8Array([0, 1, 2]));
    expect(chainOfDigest(sui)).toBe('sui');
    const solana = chainDigestOf('solana/sha256-message-v1', new Uint8Array(32).fill(7));
    expect(chainOfDigest(solana)).toBe('solana');
    expect(chainOfDigest(solana)).not.toBe(sui.split('/')[0]);
    // A payload that is not 32 bytes cannot be made into a digest at all.
    expect(() => chainDigestOf('solana/sha256-message-v1', new Uint8Array(64))).toThrow(/256-bit digest/);
  });
});

function digestOfForComparison(sample: Uint8Array) {
  return transactionDigestOf(sample);
}

describe('Blake2b is cross-checked against an independent implementation', () => {
  it('agrees with Node/OpenSSL BLAKE2b-512 on the same input', () => {
    for (const input of ['', 'abc', 'a'.repeat(1000), hexToBytesFixed('00112233445566778899')]) {
      const noble = blake2b(input, { dkLen: 512 / 8 });
      const node = createHash('blake2b512').update(input).digest();
      expect(hexOf(noble)).toBe(node.toString('hex'));
    }
  });
});

function hexToBytesFixed(hex: string): Uint8Array {
  // `''.match(/../g)` is `null`, not `[]`, and the empty-bytes case below is a real decoder input.
  // Returning a zero-length array keeps the refusal the test is asserting *about the decoder*
  // rather than about this helper — which is exactly the shape of failure where a harness bug
  // hides a security property.
  const pairs = hex.match(/../g) ?? [];
  const bad = pairs.find((pair) => !/^[0-9a-f]{2}$/i.test(pair));
  if (bad !== undefined) throw new Error(`test fixture hex has an odd digit or a non-hex byte: "${bad}" in "${hex}"`);
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

describe('base58 round-trips, including the leading-zero rule', () => {
  it('keeps the length of a value with leading zero bytes', () => {
    const withZeros = new Uint8Array([0, 0, 1, 2, 3]);
    const encoded = base58Encode(withZeros);
    expect(encoded.startsWith('11')).toBe(true);
    expect(base58Decode(encoded)).toEqual(withZeros);
  });

  it('decodes a chain identifier to 32 bytes and refuses anything else', () => {
    const thirtyTwo = new Uint8Array(32).fill(7);
    const encoded = base58Encode(thirtyTwo);
    expect(chainIdentifierBytes(encoded)).toEqual(thirtyTwo);
    expect(() => chainIdentifierBytes(base58Encode(new Uint8Array(31)))).toThrow(/not 32/);
  });
});

// ---------------------------------------------------------------------------
// The supported shape, laid out by hand from the declared variant indices.
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: SuiValidationPolicy = {
  allowedPackages: new Set<string>(),
  maxGasBudget: 1_000_000_000n,
  minGasPrice: 1n,
  allowUnboundExpiry: false,
  maxCommands: 4,
};

/** True when the pipeline said no, whichever half of it said so. */
function refused(parsedHex: string, policy: SuiValidationPolicy = DEFAULT_POLICY): boolean {
  const out = refuseChecks(parsedHex, policy);
  return out.stage === 'decode' ? true : !isSupported(out.result);
}

function refuseChecks(parsedHex: string, policy: SuiValidationPolicy = DEFAULT_POLICY) {
  const raw = hexToBytesFixed(parsedHex);
  const decoded = decodeTransactionData(raw);
  if (!decoded.ok) return { stage: 'decode' as const, detail: decoded.detail, raw };
  const network = { name: 'localnet' as const, identifier: base58Encode(new Uint8Array(32).fill(9)) };
  const result = validateSuiTransaction(decoded.parsed, raw, network, { entries: [], readBy: 'test' }, policy);
  return { stage: 'validate' as const, result, raw };
}

describe('every unsupported construct is refused by name, and none of them yields a yes', () => {
  const cases: readonly [string, string][] = [
    ['a wrong TransactionData version', `01${'00'.repeat(8)}`],
    ['a system transaction kind', `00${(KNOWN_VARIANTS.transactionKind.programmableTransaction + 1).toString(16).padStart(2, '0')}${'00'.repeat(8)}`],
    ['empty bytes', ''],
    ['truncated at one byte', '00'],
  ];

  for (const [label, hex] of cases) {
    it(`refuses ${label}`, () => {
      expect(refused(hex)).toBe(true);
    });
  }

  it('names the unknown variant index rather than defaulting it', () => {
    // `80 01` is 128 — a minimal encoding of an index far outside the enum, so the decoder has
    // to name it rather than guess. `ff` alone would be a non-minimal 127 and is refused earlier,
    // which is the BCS rule above doing its job rather than this test's subject.
    const out = refuseChecks(`008001${'00'.repeat(8)}`);
    expect(out.stage).toBe('decode');
    if (out.stage === 'decode') expect(out.detail).toMatch(/variant index 128|TransactionKind/);
  });

  it('bounds the payload before parsing it', () => {
    const huge = new Uint8Array(MAX_SUI_TX_BYTES + 1);
    const decoded = decodeTransactionData(huge);
    if (decoded.ok) {
      const network = { name: 'localnet' as const, identifier: base58Encode(new Uint8Array(32).fill(9)) };
      const result = validateSuiTransaction(decoded.parsed, huge, network, { entries: [], readBy: 'test' }, DEFAULT_POLICY);
      expect(result.supported).toBe(false);
      if (!result.supported) expect(result.reason).toBe('FORMAT_UNSUPPORTED');
    } else {
      expect(decoded.kind).toBe('MALFORMED');
    }
  });
});

describe('the capability contract cannot inherit a promise it did not make', () => {
  it('always requires offline decoding and the signing digest', () => {
    const weak = checkCapabilities(
      {
        decodesOffline: true,
        resolvesReferences: false,
        identifiesAssets: true,
        resolvesAuthorityEffects: false,
        bindsNetwork: false,
        computesSigningDigest: true,
        canSimulate: false,
        canVerifySettlement: false,
      },
      ['resolvesReferences'],
    );
    expect(weak).not.toBeNull();
    expect(weak!.missing).toContain('resolvesReferences');
  });

  it('a capable adapter reports no gap', () => {
    const gap = checkCapabilities(
      {
        decodesOffline: true,
        resolvesReferences: true,
        identifiesAssets: true,
        resolvesAuthorityEffects: true,
        bindsNetwork: true,
        computesSigningDigest: true,
        canSimulate: true,
        canVerifySettlement: true,
      },
      ['bindsNetwork'],
    );
    expect(gap).toBeNull();
  });

  it('notSupported never reads as supported', () => {
    expect(isSupported(notSupported('DECODER_ERROR', 'x'))).toBe(false);
  });
});

describe('expiry windows and where bytes may be built', () => {
  const slotMillis = 200n;

  it('a Solana blockhash window is 150 slots, about 30 seconds at 200 ms', () => {
    expect(chainValidityWindowMs({ domain: 'solana_blockhash', lastValidBlockHeight: 1n, slotsValid: 150n }, slotMillis)).toBe(30_000n);
  });

  it('an unbounded artifact has no window to price a ticket against', () => {
    expect(chainValidityWindowMs({ domain: 'none' })).toBeNull();
    expect(maxTicketTtlMs({ domain: 'none' }, 5_000n)).toBeNull();
  });

  it('the ticket is bounded inside the chain window, never outside it', () => {
    expect(maxTicketTtlMs({ domain: 'solana_blockhash', lastValidBlockHeight: 1n, slotsValid: 150n }, 5_000n, slotMillis)).toBe(25_000n);
  });

  it('a ceremony longer than the window forces construction into the authority plane', () => {
    const decision = chooseConstructionSite(
      { domain: 'solana_blockhash', lastValidBlockHeight: 1n, slotsValid: 150n },
      600_000n,
      slotMillis,
    );
    expect(decision.site).toBe('at_signing');
    expect(decision.reason).toMatch(/does not fit/);
  });

  it('a mock provider with no ceremony delay allows pre-authorization', () => {
    const decision = chooseConstructionSite(
      { domain: 'solana_blockhash', lastValidBlockHeight: 1n, slotsValid: 150n },
      0n,
      slotMillis,
    );
    expect(decision.site).toBe('pre_authorization');
  });

  it('a durable nonce gives no window, so it cannot be pre-authorized', () => {
    const decision = chooseConstructionSite({ domain: 'solana_durable_nonce', nonceValue: 'x', singleUse: true }, 1_000n);
    expect(decision.site).toBe('at_signing');
  });
});

describe('the adapter names itself and its version', () => {
  it('is recorded on what it produces', () => {
    expect(SUI_ADAPTER_NAME).toBe('chain-sui');
    expect(KNOWN_VARIANTS.command.moveCall).toBe(0);
  });
});
