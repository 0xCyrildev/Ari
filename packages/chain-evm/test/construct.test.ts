/**
 * Construction: the bytes a signature covers, verified against bytes a node signed.
 *
 * The reason this file exists rather than another set of hand-built fixtures: every vector here was
 * signed by anvil's own key and then **accepted into a block**. A node verifies secp256k1 over the
 * signing payload it builds from the transaction's fields, so if the payload this package constructs
 * differed from the canonical one by a byte — a padding slip, a field swap, a non-minimal length
 * header — no signature in the file would match the digest it implies, and these assertions would
 * fail. Hand-built fixtures cannot say that: a writer and a reader that guess alike agree with each
 * other and nobody else, which is the standing criticism of `@ari/chain-sui`'s suite.
 *
 * The `cast` cross-checks (selectors and `calldata`) were run on 2026-10-27 with foundry 1.8.1 and
 * are inlined below as literals with their provenance, so the suite needs no toolchain at run time.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CandidateTransaction } from '@ari/schemas';
import { describe, expect, it } from 'vitest';
import {
  constructEip1559Payload,
  constructEvmTransaction,
  decodeEnvelope,
  decodeSigningPayload,
  encodeErc20TransferCalldata,
  keccak256,
  evmCapabilities,
  createEvmAdapter,
  type EvmSigningRequest,
  type EvmValidationPolicy,
} from '../src/index.js';

const vectors = (
  JSON.parse(readFileSync(new URL('./vectors/evm-signing-payloads.json', import.meta.url), 'utf8')) as {
    vectors: Array<{
      name: string;
      request: Record<string, string>;
      constructed: { payload: string; byteLength: number; signingDigest: string };
      node: { signedRaw: string; transactionHash: string; from: string; receiptStatus: string };
      digests: { txHashFromRaw: string; signingDigestFromSignedEnvelope: string };
    }>;
  }
).vectors;

const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const SPENDER = '0x1111111111111111111111111111111111111111';
const UINT256_MAX = (1n << 256n) - 1n;

const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex'));
const hexOf = (b: Uint8Array): string => `0x${Buffer.from(b).toString('hex')}`;
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function requestOf(v: (typeof vectors)[number]): EvmSigningRequest {
  return {
    chainId: BigInt(v.request.chainId!),
    nonce: BigInt(v.request.nonce!),
    gasLimit: BigInt(v.request.gasLimit!),
    maxFeePerGas: BigInt(v.request.maxFeePerGas!),
    maxPriorityFeePerGas: BigInt(v.request.maxPriorityFeePerGas!),
    to: v.request.to!,
    value: BigInt(v.request.value!),
    data: bytes(v.request.data!),
  };
}

const policy: EvmValidationPolicy = {
  allowedChainIds: new Set(['31337']),
  maxFeeCostWei: 10n ** 18n,
  maxGasLimit: 200_000n,
  signerAddress: SENDER,
  expectedNonce: null,
};
const network = { name: 'localnet' as const, identifier: '31337' };
const tokenEvidence = {
  entries: [{
    id: TOKEN,
    contentBase64: Buffer.from(JSON.stringify({ decimals: 6, symbol: 'USDC' })).toString('base64'),
    contentHash: '',
    readAtSlotOrEpoch: 3n,
  }],
  readBy: 'construct.test.ts',
};

describe('constructEip1559Payload against node-signed vectors', () => {
  expect(vectors.length).toBe(3);

  for (const vector of vectors) {
    it(`${vector.name}: the payload this build writes is the payload that was signed`, () => {
      const built = constructEip1559Payload(requestOf(vector));
      if (!built.ok) throw new Error(`construction refused: ${built.reason} — ${built.detail}`);

      // 1. Byte-for-byte equality with the recorded construction.
      expect(hexOf(built.bytes)).toBe(vector.constructed.payload);
      expect(built.bytes.byteLength).toBe(vector.constructed.byteLength);
      // 2. The digest is keccak over exactly those bytes, tagged as the signing form.
      expect(built.signingDigest).toBe(vector.constructed.signingDigest);
      expect(built.signingDigest).toBe(`evm/keccak256-signing-v1:${hexOf(keccak256(built.bytes)).slice(2)}`);

      // 3. The load-bearing one: the signing digest recomputed from the *node's signed envelope*,
      //    through the independent decode path, equals the digest of the bytes constructed from the
      //    request fields. Two different entry points, one value.
      const decoded = decodeEnvelope(bytes(vector.node.signedRaw));
      if (!decoded.ok) throw new Error(`the node's own envelope does not decode: ${decoded.detail}`);
      expect(decoded.envelope.signingDigest).toBe(built.signingDigest);
      expect(vector.digests.signingDigestFromSignedEnvelope).toBe(built.signingDigest);

      // 4. The node's transaction hash is keccak over its raw bytes, and it accepted the signature.
      expect(`evm/keccak256-txhash-v1:${hexOf(keccak256(bytes(vector.node.signedRaw))).slice(2)}`)
        .toBe(`evm/keccak256-txhash-v1:${vector.node.transactionHash.slice(2)}`);
      expect(vector.node.receiptStatus).toBe('0x1');
      expect(vector.node.from).toBe(SENDER);

      // 5. The unsigned payload reads back through the signer's own entry point — the property the
      //    signing boundary depends on: the signer can re-derive this without the decision plane.
      const adapter = createEvmAdapter(policy);
      expect(adapter.signingDigestOf(built.bytes)).toBe(built.signingDigest);
      expect(adapter.signingDigestOf(bytes(vector.node.signedRaw))).toBe(built.signingDigest);

      // 6. Round trip: decoding what was written yields exactly what was asked for.
      const readBack = decodeSigningPayload(built.bytes);
      if (!readBack.ok) throw new Error(`the payload does not read back: ${readBack.detail}`);
      expect(readBack.core.chainId).toBe(built.request.chainId);
      expect(readBack.core.nonce).toBe(built.request.nonce);
      expect(readBack.core.gasLimit).toBe(built.request.gasLimit);
      expect(readBack.core.maxFeePerGas).toBe(built.request.maxFeePerGas);
      expect(readBack.core.maxPriorityFeePerGas).toBe(built.request.maxPriorityFeePerGas);
      expect(readBack.core.to).toBe(built.request.to);
      expect(readBack.core.value).toBe(built.request.value);
      expect(hexOf(readBack.core.data)).toBe(hexOf(built.request.data));
    });
  }

  it('a payload edited by one byte no longer matches the sealed digest', () => {
    // The tamper test the ticket binding is actually for: the signer compares digests, so flipping a
    // bit anywhere in the payload must move the digest, and must not be laundered by re-encoding.
    const vector = vectors[1]!;
    const request = requestOf(vector);
    const built = constructEip1559Payload(request);
    if (!built.ok) throw new Error('baseline construction failed');
    const tampered = new Uint8Array(built.bytes);
    const lastIndex = tampered.byteLength - 2;
    tampered[lastIndex] = (tampered[lastIndex]! ^ 0x01) as number;

    const adapter = createEvmAdapter(policy);
    expect(adapter.signingDigestOf(built.bytes)).toBe(built.signingDigest);
    // A flipped bit must not be laundered by re-encoding: either the bytes stop being a canonical
    // payload (null) or they name a different transaction (a different digest). Either way the sealed
    // digest no longer matches, which is the whole property the signing boundary will enforce.
    const after = adapter.signingDigestOf(tampered);
    expect(after === null || after !== built.signingDigest).toBe(true);
  });

  it('refuses a non-canonical RLP length rather than hashing it to something familiar', () => {
    // This is the collision every other encoder in this repo refuses on the wire, arriving through the
    // signing payload: two byte strings, one transaction. Measured here so the behaviour in the header
    // comments is a recorded fact and not a hope — the reader rejects the padded length outright.
    const built = constructEip1559Payload(requestOf(vectors[1]!));
    if (!built.ok) throw new Error('baseline construction failed');
    const canonical = Buffer.from(built.bytes);
    expect(canonical[0]).toBe(0x02);

    // The canonical payload is `0x02 ‖ 0xf8 ‖ LL ‖ body` (short-form list header). Rewrite that header
    // as the padded long form of the *same* length — `0xf9 0x00 LL` — which is the non-minimal encoding
    // RLP forbids, and assert the shape first so a wrong byte here cannot quietly test nothing.
    expect(canonical[1]).toBe(0xf8);
    const bodyLength = canonical[2]!;
    const padded = new Uint8Array(Buffer.concat([
      Buffer.from([0x02, 0xf9, 0x00, bodyLength]),
      canonical.subarray(3),
    ]));

    const adapter = createEvmAdapter(policy);
    expect(adapter.signingDigestOf(padded)).toBeNull();
    const read = decodeSigningPayload(padded);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('a padded length was accepted');
    expect(read.kind).toBe('MALFORMED_BYTES');
    expect(read.detail).toMatch(/zero-padded/);
    // Control: the unpadded bytes still work, so the refusal above is about the encoding, not the size.
    expect(adapter.signingDigestOf(canonical)).toBe(built.signingDigest);
  });
});

describe('encodeErc20TransferCalldata against cast', () => {
  // cast calldata 'transfer(address,uint256)' 0x3f2a…2b3c 2000000000   (foundry 1.8.1, 2026-10-27)
  it('matches cast for an ordinary amount', () => {
    expect(encodeErc20TransferCalldata(RECIPIENT, 2_000_000_000n))
      .toBe('0xa9059cbb0000000000000000000000003f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c0000000000000000000000000000000000000000000000000000000077359400');
  });

  it('matches cast for type(uint256).max, the unlimited-allowance amount', () => {
    // cast calldata 'approve(address,uint256)' 0x1111…1111 115792089237316195423570985008687907853269984665640564039457584007913129639935
    // `approve` is the same ABI shape as `transfer` under a different selector, which is precisely why
    // an encoder that swapped only the four selector bytes is dangerous: the address word is the
    // *spender* here, not a recipient. Asserting both halves is the check.
    const approve = (spender: string, amount: bigint): string =>
      `0x095ea7b3${encodeErc20TransferCalldata(spender, amount).slice(10)}`;
    expect(approve(SPENDER, UINT256_MAX)).toBe(
      '0x095ea7b30000000000000000000000001111111111111111111111111111111111111111' + 'f'.repeat(64),
    );
    expect(approve(RECIPIENT, 2_000_000_000n)).not.toBe(encodeErc20TransferCalldata(RECIPIENT, 2_000_000_000n));
  });

  it('refuses an amount that does not fit a uint256 word rather than truncating it', () => {
    expect(() => encodeErc20TransferCalldata(RECIPIENT, 1n << 256n)).toThrow(/uint256/);
    expect(() => encodeErc20TransferCalldata(RECIPIENT, -1n)).toThrow(/negative/);
    expect(() => encodeErc20TransferCalldata('0xdeadbeef', 1n)).toThrow(/lowercase/);
  });
});

describe('constructEvmTransaction — candidate to validated transaction', () => {
  // The replay-protection numbers come from the vector itself. Hardcoding a nonce here would compare
  // a candidate against a transaction the node signed with a *different* sequence and quietly pass on
  // everything except the digest — which is the one assertion this block exists to make.
  const paidFor = vectors[1]!.request;
  const protection = {
    scheme: 'account_sequence',
    nonce: paidFor.nonce!,
    chainId: paidFor.chainId!,
    gasLimit: paidFor.gasLimit!,
    maxFeePerUnit: paidFor.maxFeePerGas!,
    maxPriorityFeePerUnit: paidFor.maxPriorityFeePerGas!,
  };

  const common = {
    requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    agentId: 'agt_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    deadline: '2026-12-31T23:59:59.000Z',
    idempotencyKey: 'inv-1',
    usdEstimate: null,
  };

  const parse = (input: Record<string, unknown>) => {
    const parsed = CandidateTransaction.safeParse(input);
    if (!parsed.success) throw new Error(`candidate rejected: ${parsed.error.message}`);
    return parsed.data;
  };

  const transfer = (over: Record<string, unknown> = {}): CandidateTransaction => parse({
    ...common,
    kind: 'transfer',
    chain: 'ethereum',
    asset: { kind: 'erc20', chain: 'ethereum', contract: TOKEN, symbol: 'USDC', decimals: 6 },
    amount: { raw: '2000000000', unit: 'usdc-6dp' },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    replayProtection: protection,
    ...over,
  });

  const contractCall = (over: Record<string, unknown> = {}): CandidateTransaction => parse({
    ...common,
    kind: 'contract_call',
    chain: 'ethereum',
    contract: TOKEN,
    selector: '0x095ea7b3',
    calldata: '0x',
    value: '0',
    replayProtection: protection,
    ...over,
  });

  it('produces the same bytes the node signed for the same numbers', () => {
    const result = constructEvmTransaction(transfer(), network, tokenEvidence, policy);
    if (!result.supported) throw new Error(`refused: ${result.reason} — ${result.detail}`);
    const vector = vectors[1]!;

    expect(result.signingDigest).toBe(vector.constructed.signingDigest);
    expect(result.bytesSha256).toBe(sha256Hex(bytes(vector.constructed.payload)));
    expect(result.byteLength).toBe(BigInt(vector.constructed.byteLength));
    // No signature exists yet, so no transaction hash exists. This is the decision `envelope.ts`
    // records: inventing one here would hand reconciliation a receipt key that resolves to nothing.
    expect(result.txDigest).toBeNull();
    expect(result.chain).toBe('evm');
    expect(result.expiry).toEqual({ domain: 'evm_nonce', nonce: BigInt(paidFor.nonce!), chainBound: true });
    expect(result.signer).toBe(SENDER);

    const moved = result.effects.find((effect) => effect.kind === 'transfer');
    expect(moved).toMatchObject({ kind: 'transfer', amountRaw: 2_000_000_000n, to: RECIPIENT, from: SENDER });
    if (moved?.kind !== 'transfer') throw new Error('expected a transfer effect');
    if (moved.asset.kind !== 'erc20') throw new Error('expected an erc20 asset');
    expect(moved.asset).toMatchObject({ contract: TOKEN, decimals: 6n, unit: 'usdc-6dp' });

    const fee = result.effects.find((effect) => effect.kind === 'fee');
    expect(fee).toMatchObject({ kind: 'fee', maxAmountRaw: BigInt(paidFor.gasLimit!) * BigInt(paidFor.maxFeePerGas!) });
    expect(result.stateDependencies.map((d) => d.kind)).toContain('evm_token_metadata');
  });

  it('an approve becomes an approval effect and an authority exercise, not a transfer', () => {
    const result = constructEvmTransaction(contractCall({
      calldata: `0x${encodeErc20TransferCalldata(SPENDER, UINT256_MAX).slice(10)}`,
    }), network, tokenEvidence, policy);
    if (!result.supported) throw new Error(`refused: ${result.reason} — ${result.detail}`);
    expect(result.effects.some((effect) => effect.kind === 'approval')).toBe(true);
    expect(result.effects.some((effect) => effect.kind === 'transfer')).toBe(false);
    expect(result.authorities).toHaveLength(1);
    expect(result.authorities[0]).toMatchObject({ kind: 'evm_erc20_approval', spender: SPENDER, unlimited: true });
  });

  const NO_EVIDENCE = { entries: [], readBy: 'none' };
  const refusals: ReadonlyArray<{ name: string; candidate: CandidateTransaction; evidence: typeof tokenEvidence; expected: string }> = [
    {
      name: 'a native transfer has no policy bound to price it',
      candidate: transfer({ asset: { kind: 'native', chain: 'ethereum' }, amount: { raw: '1000', unit: 'eth-wei' } }),
      evidence: tokenEvidence,
      expected: 'ARGUMENT_UNRESOLVED',
    },
    {
      name: 'a contract call carrying native value',
      candidate: contractCall({ value: '5' }),
      evidence: tokenEvidence,
      expected: 'AUTHORITY_EXERCISED',
    },
    {
      name: 'a chain this deployment is not on',
      candidate: transfer({ replayProtection: { ...protection, chainId: '1' } }),
      evidence: tokenEvidence,
      expected: 'NETWORK_UNSUPPORTED',
    },
    {
      name: 'a tip above the fee cap',
      candidate: transfer({ replayProtection: { ...protection, maxFeePerUnit: '1000000000', maxPriorityFeePerUnit: '20000000000' } }),
      evidence: tokenEvidence,
      expected: 'MALFORMED_BYTES',
    },
    {
      name: 'a gas limit above the policy maximum',
      candidate: transfer({ replayProtection: { ...protection, gasLimit: '900000' } }),
      evidence: tokenEvidence,
      expected: 'AUTHORITY_EXERCISED',
    },
    {
      name: 'an ERC-20 payment with no token metadata read',
      candidate: transfer(),
      evidence: NO_EVIDENCE,
      expected: 'ARGUMENT_UNRESOLVED',
    },
  ];

  for (const refusal of refusals) {
    it(`refuses ${refusal.name} with ${refusal.expected}`, () => {
      const result = constructEvmTransaction(refusal.candidate, network, refusal.evidence, policy);
      expect(result.supported).toBe(false);
      if (result.supported) throw new Error('a refusal was expected');
      expect(result.reason).toBe(refusal.expected);
      // Uncertainty is never a warning attached to a partial answer: there is nothing to evaluate.
      expect('effects' in result).toBe(false);
    });
  }

  it('refuses a nonce the chain has already moved past, rather than queueing an authorization', () => {
    const result = constructEvmTransaction(transfer(), network, tokenEvidence, { ...policy, expectedNonce: 0n });
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('a refusal was expected');
    expect(result.reason).toBe('STATE_STALE');
  });

  it('capabilities say the truth about what construction can promise', () => {
    const declared = evmCapabilities(policy);
    expect(declared.computesSigningDigest).toBe(true);
    expect(declared.decodesOffline).toBe(true);
    // Construction reads no chain state and cannot verify a settlement: the ticket binds bytes, and
    // nothing here claims the transaction was ever mined.
    expect(declared.canVerifySettlement).toBe(false);
    expect(declared.resolvesReferences).toBe(false);
  });
});
