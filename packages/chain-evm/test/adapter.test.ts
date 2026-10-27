/**
 * The EVM adapter, verified against bytes this repository did not produce.
 *
 * `test/vectors/evm-envelopes.json` holds four signed transactions created on this box by anvil
 * 1.8.1 and read back with `cast tx --raw`, together with the fields the node itself reported. That
 * provenance is the point, and it is what separates this file from
 * `packages/chain-sui/test/decoder.test.ts`: the Sui fixtures are laid out by this author to match
 * this author's decoder, so the two can agree about a wire format and be wrong together. These bytes
 * were encoded by Foundry, and every assertion compares what `@ari/chain-evm` reads out of them
 * against what Foundry says they mean.
 *
 * Two independent checks, not one:
 *   - `keccak256(raw)` equals the node's `hash`. Tests the hash and the envelope boundary, because
 *     the node's identifier is over exactly these bytes.
 *   - every decoded field equals the node's field. Tests the RLP reader, because a mis-aligned
 *     reader yields a plausible wrong number rather than an error.
 *
 * Adapter maturity this file supports (brief §6.5): parsing and semantic validation for a closed
 * subset, verified against an independent implementation on a local chain. NOT signing integration
 * (this adapter signs nothing), NOT submission, NOT receipt-based outcome verification.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainDigestBytes, checkCapabilities, isSupported } from '@ari/chain-core';
import {
  ERC20_APPROVE_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  UINT256_MAX,
  createEvmAdapter,
  decodeEnvelope,
  evmCapabilities,
  keccak256,
  selectorOf,
  validateEvmTransaction,
  type EvmValidationPolicy,
} from '../src/index.js';
import {
  RlpError,
  decodeRlp,
  encodeBytes,
  encodeList,
  encodeQuantity,
  asBytes,
  asQuantity,
} from '../src/rlp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
interface NodeFields {
  readonly type: string;
  readonly chainId?: string;
  readonly nonce: string;
  readonly gas: string;
  readonly gasPrice?: string;
  readonly maxFeePerGas?: string;
  readonly maxPriorityFeePerGas?: string;
  readonly to: string | null;
  readonly value: string;
  readonly input: string;
  readonly from: string;
  readonly accessList?: unknown[];
  readonly hash: string;
}
interface Vector {
  readonly name: string;
  readonly hash: string;
  readonly raw: string;
  readonly node: NodeFields;
}
const fixture = JSON.parse(readFileSync(resolve(HERE, 'vectors/evm-envelopes.json'), 'utf8')) as {
  signer: string;
  chainId: string;
  vectors: Vector[];
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const n = (value: string | undefined): bigint => (value === undefined ? 0n : BigInt(value));

const SIGNER = fixture.signer;

const POLICY: EvmValidationPolicy = {
  allowedChainIds: new Set([fixture.chainId]),
  maxFeeCostWei: 1n * 10n ** 18n,
  maxGasLimit: 1_000_000n,
  signerAddress: SIGNER,
  expectedNonce: 9n,
};

const NETWORK = { name: 'localnet' as const, identifier: fixture.chainId };

const adapterFor = (policy = POLICY) => createEvmAdapter(policy);

const tokenEvidenceFor = (contract: string, decimals = 6, symbol = 'mUSD') => ({
  entries: [{
    id: contract,
    contentBase64: Buffer.from(JSON.stringify({ decimals, symbol })).toString('base64'),
    contentHash: '0'.repeat(64),
    readAtSlotOrEpoch: 1n,
  }],
  readBy: 'vector',
});

// ---------------------------------------------------------------------------
// Vectors: real bytes, real node's answer.
// ---------------------------------------------------------------------------

describe('the adapter reads Foundry-encoded envelopes the way Foundry does', () => {
  for (const vector of fixture.vectors) {
    describe(vector.name, () => {
      const bytes = new Uint8Array(Buffer.from(vector.raw.slice(2), 'hex'));

      it('hashes to the identifier the node indexes this transaction by', () => {
        const decoded = decodeEnvelope(bytes);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        // The chain's own `hash`, not an Ari-internal label. If the envelope boundary or the hash
        // were wrong, this is the assertion that says so — and it says so against anvil, not against
        // this package's own writer.
        expect(`0x${hex(chainDigestBytes(decoded.envelope.txDigest))}`).toBe(vector.node.hash);
      });

      it('decodes every field the node reports', () => {
        const decoded = decodeEnvelope(bytes);
        if (!decoded.ok) throw new Error(`vector failed to decode: ${decoded.detail}`);
        const e = decoded.envelope;
        expect(e.nonce).toBe(n(vector.node.nonce));
        expect(e.gasLimit).toBe(n(vector.node.gas));
        expect(e.value).toBe(n(vector.node.value));
        expect(e.to).toBe(vector.node.to === null ? null : vector.node.to.toLowerCase());
        expect(hex(e.data)).toBe(vector.node.input.slice(2).toLowerCase());
        expect(e.chainId).toBe(BigInt(fixture.chainId));
        if (vector.node.type === '0x0') {
          expect(e.form).toBe('legacy');
          expect(e.gasPrice).toBe(n(vector.node.gasPrice));
        } else {
          expect(e.form).toBe('eip1559');
          expect(e.maxFeePerGas).toBe(n(vector.node.maxFeePerGas));
          expect(e.maxPriorityFeePerGas).toBe(n(vector.node.maxPriorityFeePerGas));
        }
      });

      it('recomputes a stable signing digest, and it is not the transaction hash', () => {
        const decoded = decodeEnvelope(bytes);
        if (!decoded.ok) return;
        const once = decoded.envelope.signingDigest;
        const twice = adapterFor().signingDigestOf(bytes);
        // The signer re-derives this from the bytes it was handed. If the two disagreed, the ticket's
        // sealed digest could never match what the signer computes.
        expect(twice).toBe(once);
        expect(once).not.toBe(decoded.envelope.txDigest);
        expect(once.startsWith('evm/keccak256-signing-v1:')).toBe(true);
      });
    });
  }

  it('validates the native transfer end to end', () => {
    const vector = fixture.vectors.find((v) => v.name === 'eip1559-native-transfer');
    if (vector === undefined) throw new Error('the vector set lost its native transfer');
    const bytes = new Uint8Array(Buffer.from(vector.raw.slice(2), 'hex'));
    const policy = { ...POLICY, expectedNonce: n(vector.node.nonce) };
    const result = adapterFor(policy).decode(bytes, NETWORK, { entries: [], readBy: 'none' });
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.chain).toBe('evm');
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]).toMatchObject({
      kind: 'transfer',
      amountRaw: 7n,
      from: SIGNER,
      to: vector.node.to?.toLowerCase(),
    });
    expect(result.effects[1]).toMatchObject({ kind: 'fee', paidBy: SIGNER });
    expect(result.expiry).toEqual({ domain: 'evm_nonce', nonce: n(vector.node.nonce), chainBound: true });
    expect(result.stateDependencies).toEqual([]);
    expect(result.signer).toBe(SIGNER);
  });

  it('refuses the ERC-20 vector rather than guessing its decimals', () => {
    // The 68-byte calldata vector is a real `transfer(address,uint256)`. With no token metadata
    // supplied, the amount is a bare uint256 that no limit can be compared against — so a build that
    // assumed 18 decimals would authorize an amount off by a factor of 10^12 for a 6-decimal token.
    const vector = fixture.vectors.find((v) => v.name === 'eip1559-erc20-transfer-calldata');
    if (vector === undefined) throw new Error('the vector set lost its calldata transaction');
    const bytes = new Uint8Array(Buffer.from(vector.raw.slice(2), 'hex'));
    const noEvidence = adapterFor().decode(bytes, NETWORK, { entries: [], readBy: 'none' });
    expect(noEvidence.supported).toBe(false);
    if (noEvidence.supported) return;
    expect(noEvidence.reason).toBe('ARGUMENT_UNRESOLVED');
    expect(noEvidence.partiallyParsed).toBe(true);

    const withEvidence = adapterFor().decode(bytes, NETWORK, tokenEvidenceFor(vector.node.to!));
    expect(isSupported(withEvidence)).toBe(true);
    if (!isSupported(withEvidence)) return;
    expect(withEvidence.effects[0]).toMatchObject({
      kind: 'transfer',
      asset: { kind: 'erc20', contract: vector.node.to!.toLowerCase(), decimals: 6n, unit: 'musd-6dp' },
    });
    expect(withEvidence.stateDependencies).toHaveLength(1);
  });

  it('refuses a transaction on the wrong chain, before it reads anything else', () => {
    const vector = fixture.vectors[0];
    if (vector === undefined) throw new Error('no vectors');
    const bytes = new Uint8Array(Buffer.from(vector.raw.slice(2), 'hex'));
    const result = adapterFor().decode(bytes, { name: 'mainnet', identifier: '1' }, { entries: [], readBy: 'none' });
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('NETWORK_UNSUPPORTED');
    expect(result.detail).toContain('chainId');
  });

  it('refuses an envelope whose nonce is ahead of the observed account nonce', () => {
    const vector = fixture.vectors[1];
    if (vector === undefined) throw new Error('no vectors');
    const bytes = new Uint8Array(Buffer.from(vector.raw.slice(2), 'hex'));
    const policy = { ...POLICY, expectedNonce: n(vector.node.nonce) - 1n };
    const result = adapterFor(policy).decode(bytes, NETWORK, { entries: [], readBy: 'none' });
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('STATE_STALE');
  });
});

// ---------------------------------------------------------------------------
// The writer/encoder, checked against the reader — and, where a vector exists, against anvil too.
// ---------------------------------------------------------------------------

describe('RLP refuses the ways a parser gets fooled', () => {
  it('round-trips strings, lists and quantities', () => {
    const cases: [Uint8Array, string][] = [
      [new Uint8Array([]), 'empty string'],
      [new Uint8Array([0x00]), 'zero byte'],
      [new Uint8Array([0x7f]), 'single byte at the boundary'],
      [new Uint8Array([0x80]), 'a byte that needs the string header'],
      [new Uint8Array(55), 'a 55-byte string, still short form'],
      [new Uint8Array(56), 'a 56-byte string, first long form'],
    ];
    for (const [value, label] of cases) {
      const encoded = new Uint8Array(encodeBytes(value));
      const back = asBytes(decodeRlp(encoded), label);
      expect(hex(back)).toBe(hex(value));
    }
    for (const value of [0n, 1n, 0x7fn, 0x80n, 255n, 1_000_000_000n, 10n ** 24n]) {
      expect(asQuantity(decodeRlp(new Uint8Array(encodeQuantity(value))), 'quantity')).toBe(value);
    }
  });

  it('rejects a short string written in the long form', () => {
    // `0xb8 0x01 0x41` and `0x41` are the same string to a lenient reader, which is two byte strings
    // for one transaction and therefore two digests for one operation.
    expect(() => decodeRlp(new Uint8Array([0xb8, 0x01, 0x41]))).toThrowError(RlpError);
    expect(() => decodeRlp(new Uint8Array([0x81, 0x41]))).toThrow(/must be encoded as itself/);
    try {
      decodeRlp(new Uint8Array([0xb8, 0x01, 0x41]));
    } catch (error) {
      expect((error as RlpError).kind).toBe('NON_CANONICAL');
    }
  });

  it('rejects a quantity with a leading zero byte', () => {
    // `0x82 0x00 0x01` is 1 written three ways; only `0x01` is canonical.
    expect(() => asQuantity(new Uint8Array([0x00, 0x01]), 'value')).toThrow(/leading zero/);
    expect(asQuantity(new Uint8Array([]), 'value')).toBe(0n);
  });

  it('rejects trailing bytes and a list whose members overrun its declared span', () => {
    expect(() => decodeRlp(new Uint8Array([0xc0, 0xff]))).toThrowError(RlpError);
    // A list declaring ONE payload byte, whose only member is a 20-byte string. The reader stops
    // when the declared span is exceeded and the offsets no longer agree.
    //
    // The first version of this assertion used `[0xc2, 0x01, 0x00]` and expected a refusal — but that
    // is a *correct* two-item list (`0x01` and `0x00` are each their own single-byte string), so the
    // reader accepted it and the fixture, not the parser, was wrong. An assertion that a valid input
    // is refused is the kind of failure that reads like a security hole and is a test bug.
    const overrunning = new Uint8Array([0xc1, 0x94, ...new Array(30).fill(0x00)]);
    expect(() => decodeRlp(overrunning)).toThrow(/do not fill/);
  });

  it('refuses a pre-EIP-155 legacy signature rather than binding it to the deployment', () => {
    // Hand-built: nine fields with v = 27. No chain id is asserted by these bytes, so they are valid
    // wherever the key works, which is the whole reason this is a refusal and not a default.
    const pre155 = new Uint8Array(encodeList([
      encodeQuantity(0n),
      encodeQuantity(20_000_000_000n),
      encodeQuantity(21_000n),
      encodeBytes(new Uint8Array(Buffer.from('3535353535353535353535353535353535353535', 'hex'))),
      encodeQuantity(1n),
      encodeBytes(new Uint8Array(0)),
      encodeQuantity(27n),
      encodeQuantity(1n),
      encodeQuantity(2n),
    ]));
    const decoded = decodeEnvelope(pre155);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.kind).toBe('FORMAT_UNSUPPORTED');
    expect(decoded.detail).toMatch(/pre-EIP-155|chain id/);
  });

  it('refuses a typed envelope whose access list is not empty', () => {
    const withAccessList = new Uint8Array([
      0x02,
      ...encodeList([
        encodeQuantity(31337n),
        encodeQuantity(0n),
        encodeQuantity(1n),
        encodeQuantity(2n),
        encodeQuantity(21_000n),
        encodeBytes(new Uint8Array(Buffer.from('1111111111111111111111111111111111111111', 'hex'))),
        encodeQuantity(7n),
        encodeBytes(new Uint8Array(0)),
        encodeList([encodeList([
          encodeBytes(new Uint8Array(Buffer.from('1111111111111111111111111111111111111111', 'hex'))),
          encodeList([encodeBytes(new Uint8Array(32))]),
        ])]),
        encodeQuantity(0n),
        encodeQuantity(1n),
        encodeQuantity(2n),
      ]),
    ]);
    const result = adapterFor().decode(withAccessList, NETWORK, { entries: [], readBy: 'none' });
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('OPERATION_UNSUPPORTED');
    expect(result.detail).toMatch(/access-list|access list/i);
  });
});

// ---------------------------------------------------------------------------
// The supported set and its refusals, on hand-built envelopes.
// ---------------------------------------------------------------------------

const ADDRESS_A = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';

function word(hexNoPrefix: string): number[] {
  return [...new Uint8Array(Buffer.from(hexNoPrefix.padStart(64, '0'), 'hex'))];
}

function erc20Calldata(selector: string, target: string, amount: bigint): Uint8Array {
  return new Uint8Array([
    ...Buffer.from(selector.slice(2), 'hex'),
    ...word(target.slice(2)),
    ...word(amount.toString(16)),
  ]);
}

interface BuildOptions {
  readonly to?: string | null;
  readonly value?: bigint;
  readonly data?: Uint8Array;
  readonly nonce?: bigint;
  readonly gasLimit?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly gasPrice?: bigint;
  readonly chainId?: bigint;
}

/** A signed-looking EIP-1559 envelope. `r`/`s` are placeholders: this adapter does no recovery. */
function eip1559Envelope(options: BuildOptions): Uint8Array {
  const to = options.to === undefined ? ADDRESS_A : options.to;
  return new Uint8Array([
    0x02,
    ...encodeList([
      encodeQuantity(options.chainId ?? 31337n),
      encodeQuantity(options.nonce ?? 3n),
      encodeQuantity(options.maxPriorityFeePerGas ?? 100_000_000n),
      encodeQuantity(options.maxFeePerGas ?? 2_000_000_000n),
      encodeQuantity(options.gasLimit ?? 21_000n),
      encodeBytes(to === null ? new Uint8Array(0) : new Uint8Array(Buffer.from(to.slice(2), 'hex'))),
      encodeQuantity(options.value ?? 0n),
      encodeBytes(options.data ?? new Uint8Array(0)),
      encodeList([]),
      encodeQuantity(1n),
      encodeQuantity(1n),
      encodeQuantity(2n),
    ]),
  ]);
}

describe('the supported set', () => {
  const policyFor = (overrides: Partial<EvmValidationPolicy> = {}): EvmValidationPolicy =>
    ({ ...POLICY, ...overrides });

  it('accepts a native transfer', () => {
    const bytes = eip1559Envelope({ value: 1_000n });
    const result = adapterFor(policyFor({ expectedNonce: 3n })).decode(bytes, NETWORK, { entries: [], readBy: 'none' });
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.effects[0]).toMatchObject({ kind: 'transfer', amountRaw: 1_000n, to: ADDRESS_A });
    expect(result.effects[1]).toMatchObject({ kind: 'fee', maxAmountRaw: 21_000n * 2_000_000_000n });
  });

  it('accepts an ERC-20 transfer and names the token, not a bare uint256', () => {
    const data = erc20Calldata(ERC20_TRANSFER_SELECTOR, ADDRESS_A, 1_000_000n);
    const result = adapterFor(policyFor({ expectedNonce: 3n }))
      .decode(eip1559Envelope({ to: TOKEN, data }), NETWORK, tokenEvidenceFor(TOKEN));
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.effects[0]).toMatchObject({
      kind: 'transfer',
      amountRaw: 1_000_000n,
      to: ADDRESS_A,
      asset: { kind: 'erc20', contract: TOKEN },
    });
    expect(result.authorities).toEqual([]);
  });

  it('accepts an ERC-20 approve as an approval, never as a transfer', () => {
    // The grant moves nothing. Recording it as a `transfer` would let a policy that bounds outflows
    // read a spend-until-revoked grant as a completed $0 payment.
    const data = erc20Calldata(ERC20_APPROVE_SELECTOR, ADDRESS_A, UINT256_MAX);
    const result = adapterFor(policyFor({ expectedNonce: 3n }))
      .decode(eip1559Envelope({ to: TOKEN, data }), NETWORK, tokenEvidenceFor(TOKEN));
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.effects.filter((e) => e.kind === 'approval')).toHaveLength(1);
    expect(result.effects.filter((e) => e.kind === 'transfer')).toHaveLength(0);
    expect(result.authorities).toHaveLength(1);
    expect(result.authorities[0]).toMatchObject({ kind: 'evm_erc20_approval', spender: ADDRESS_A, unlimited: true });
  });

  it('distinguishes a bounded approval from an unlimited one', () => {
    const data = erc20Calldata(ERC20_APPROVE_SELECTOR, ADDRESS_A, 500n);
    const result = adapterFor(policyFor({ expectedNonce: 3n }))
      .decode(eip1559Envelope({ to: TOKEN, data }), NETWORK, tokenEvidenceFor(TOKEN));
    if (!isSupported(result)) throw new Error(result.detail);
    expect(result.authorities[0]).toMatchObject({ unlimited: false, amountRaw: 500n });
  });
});

describe('every out-of-set envelope is refused by name', () => {
  const policy = { ...POLICY, expectedNonce: 3n };
  const evidence = tokenEvidenceFor(TOKEN);

  /**
   * The reason is pinned per case, not "either of two". `validateEvmTransaction` has one check order,
   * so a case that lands on a different refusal than the table says is either a reordering or a
   * fixture bug — both worth failing on. A table that accepted two answers would pass either way and
   * prove nothing, which is the mistake `~/AGENTS.md` calls "the unit test passed either way".
   */
  const cases: readonly [string, Uint8Array, string][] = [
    ['contract creation', eip1559Envelope({ to: null, value: 1n }), 'OPERATION_UNSUPPORTED'],
    ['a zero-value call with no calldata', eip1559Envelope({ value: 0n }), 'OPERATION_UNSUPPORTED'],
    ['calldata plus a native value', eip1559Envelope({ value: 5n, data: erc20Calldata(ERC20_TRANSFER_SELECTOR, ADDRESS_A, 1n) }), 'OPERATION_UNSUPPORTED'],
    ['an unknown selector', eip1559Envelope({ data: erc20Calldata('0x06fdde03', ADDRESS_A, 1n) }), 'OPERATION_UNSUPPORTED'],
    ['a transfer of zero', eip1559Envelope({ to: TOKEN, data: erc20Calldata(ERC20_TRANSFER_SELECTOR, ADDRESS_A, 0n) }), 'OPERATION_UNSUPPORTED'],
    ['a truncated ERC-20 call', eip1559Envelope({ to: TOKEN, data: erc20Calldata(ERC20_TRANSFER_SELECTOR, ADDRESS_A, 1n).subarray(0, 40) }), 'MALFORMED_BYTES'],
    ['an address word with dirty padding', eip1559Envelope({
      to: TOKEN,
      data: new Uint8Array([
        ...Buffer.from(ERC20_TRANSFER_SELECTOR.slice(2), 'hex'),
        ...new Uint8Array(Buffer.from('deadd00d' + '00'.repeat(24), 'hex')),
        ...word('01'),
      ]),
    }), 'MALFORMED_BYTES'],
    ['a gas limit above the policy maximum', eip1559Envelope({ value: 1n, gasLimit: 2_000_000n }), 'AUTHORITY_EXERCISED'],
    ['a fee cost above the policy maximum', eip1559Envelope({ value: 1n, gasLimit: 21_000n, maxFeePerGas: 100_000_000_000_000n }), 'AUTHORITY_EXERCISED'],
    ['a priority fee above the fee cap', eip1559Envelope({ value: 1n, maxPriorityFeePerGas: 9n * 10n ** 9n }), 'MALFORMED_BYTES'],
    ['a chain id the deployment is not on', eip1559Envelope({ value: 1n, chainId: 1n }), 'NETWORK_UNSUPPORTED'],
    ['an ERC-20 call with no token metadata', eip1559Envelope({ to: TOKEN, data: erc20Calldata(ERC20_TRANSFER_SELECTOR, ADDRESS_A, 1n) }), 'ARGUMENT_UNRESOLVED'],
  ];

  for (const [label, bytes, reason] of cases) {
    it(`refuses ${label} with ${reason}`, () => {
      // The metadata case must genuinely have no metadata; every other case gets the token entry so
      // the refusal under test is the one named in the table.
      const evidenceForCase = reason === 'ARGUMENT_UNRESOLVED' && label.includes('metadata')
        ? { entries: [], readBy: 'none' }
        : evidence;
      const result = adapterFor(policy).decode(bytes, NETWORK, evidenceForCase);
      expect(result.supported).toBe(false);
      if (result.supported) return;
      expect(result.reason).toBe(reason);
      expect(result.detail.length).toBeGreaterThan(10);
    });
  }

  it('refuses a configured signer address that is not an address', () => {
    const bytes = eip1559Envelope({ value: 1n });
    const decoded = decodeEnvelope(bytes);
    if (!decoded.ok) throw new Error(`fixture failed to decode: ${decoded.detail}`);
    const result = validateEvmTransaction(decoded.envelope, bytes, NETWORK, { entries: [], readBy: 'none' }, { ...policy, signerAddress: '0xBAD' });
    expect(result.supported).toBe(false);
    if (result.supported) return;
    // `DECODER_ERROR`, because a deployment whose own configuration is unparseable is a fault in the
    // enforcement component — and it must never be dressed up as "this transaction is unsupported".
    expect(result.reason).toBe('DECODER_ERROR');
  });
});

describe('decode is total', () => {
  it('never throws, across random, truncated and oversized inputs', () => {
    const adapter = adapterFor();
    const probes: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0x02]),
      new Uint8Array([0xff]),
      new Uint8Array(102_401),
      new Uint8Array(Buffer.from(fixture.vectors[0]!.raw.slice(2, 40), 'hex')),
    ];
    for (let i = 0; i < 400; i += 1) {
      probes.push(Uint8Array.from(Array.from({ length: (i * 41) % 220 }, () => Math.floor(Math.random() * 256))));
    }
    for (const probe of probes) {
      const result = adapter.decode(probe, NETWORK, tokenEvidenceFor(TOKEN));
      expect(typeof result.supported).toBe('boolean');
      if (!result.supported) expect(typeof result.reason).toBe('string');
    }
  });

  it('bounds the payload before parsing it', () => {
    const result = adapterFor().decode(new Uint8Array(102_401), NETWORK, { entries: [], readBy: 'none' });
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('FORMAT_UNSUPPORTED');
  });

  it('reports null rather than a digest it cannot re-derive', () => {
    expect(adapterFor().signingDigestOf(new Uint8Array([0xff, 0x00]))).toBeNull();
    expect(adapterFor().signingDigestOf(new Uint8Array(102_401))).toBeNull();
  });
});

describe('capabilities describe this build', () => {
  it('claims network binding and no simulation or settlement', () => {
    const declared = evmCapabilities(POLICY);
    expect(declared.bindsNetwork).toBe(true);
    expect(declared.computesSigningDigest).toBe(true);
    expect(declared.decodesOffline).toBe(true);
    expect(declared.identifiesAssets).toBe(true);
    expect(declared.resolvesAuthorityEffects).toBe(true);
    expect(declared.canSimulate).toBe(false);
    expect(declared.canVerifySettlement).toBe(false);
    expect(declared.resolvesReferences).toBe(false);
    expect(checkCapabilities(declared, ['bindsNetwork', 'canSimulate'])?.missing).toEqual(['canSimulate']);
  });

  it('the adapter object carries the set it declares', () => {
    const adapter = adapterFor();
    expect(adapter.capabilities).toEqual(evmCapabilities(POLICY));
    expect(adapter.chain).toBe('evm');
    expect(adapter.name).toBe('chain-evm');
  });
});

describe('selector derivation is the real keccak, not a table lookup', () => {
  it('matches the four-byte prefixes the supported set names', () => {
    // These two selectors are the entire ABI surface this adapter trusts, and a wrong one means the
    // adapter is decoding a different function than it claims. Verified against
    // `cast sig 'transfer(address,uint256)'` and `cast sig 'approve(address,uint256)'` on this box.
    expect(selectorOf(new Uint8Array(Buffer.from('00', 'hex')))).toBe('0x');
    const keccakHex = (input: Uint8Array): string => `0x${hex(keccak256(input)).slice(0, 8)}`;
    expect(keccakHex(new Uint8Array(Buffer.from('transfer(address,uint256)', 'utf8')))).toBe(ERC20_TRANSFER_SELECTOR);
    expect(keccakHex(new Uint8Array(Buffer.from('approve(address,uint256)', 'utf8')))).toBe(ERC20_APPROVE_SELECTOR);
  });
});
