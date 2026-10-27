/**
 * The composed adapter: fixtures built by `fixtures.ts`, and the refusal set that only a positive
 * case makes meaningful.
 *
 * `decoder.test.ts` proved the reader is strict and every unknown variant is refused — and it
 * contained **no test that produced `supported: true`**, so an adapter that refused every transaction
 * it was ever handed would have passed all 31 of them. A refusal-only suite cannot tell "this shape
 * is dangerous" apart from "this decoder does not work". These fixtures close that gap.
 *
 * What they therefore prove, precisely:
 *   PROVED — that parse and classify compose; that the supported shape yields the amounts,
 *     addresses, digests and expiry the parsed fields say; and that each named danger construct
 *     (FundsWithdrawal, `Receiving`, shared objects, `NestedResult`, a third command) is refused
 *     rather than quietly accepted.
 *   PROVED — totality: no input, valid or hostile, makes `decode` throw.
 *   NOT PROVED — that the byte layout is what Sui emits. It is what `decode.ts` documents, and a
 *     writer and a reader that guess the same way agree with each other and nobody else. That is
 *     `test/vectors.test.ts`'s job, against bytes from real Sui tooling, and it is still open.
 */

import { describe, expect, it } from 'vitest';
import { ChainTransactionDigest, checkCapabilities, isSupported } from '@ari/chain-core';
import {
  MAX_SUI_TX_BYTES,
  SUI_DECODER_VERSION,
  createSuiAdapter,
  normalizeTypeTag,
  suiCapabilities,
  transactionDigestOf,
  type SuiValidationPolicy,
} from '../src/index.js';
import { digestHex } from '../src/digest.js';
import {
  COIN,
  OTHER,
  NO_EVIDENCE,
  RECIPIENT,
  SENDER,
  addrPure,
  addrWire,
  argGas,
  argInput,
  argNested,
  argResult,
  cmdMakeMoveVec,
  cmdMergeCoins,
  cmdMoveCall,
  cmdSplitCoins,
  cmdTransferObjects,
  coinEvidence,
  mkAddress,
  expEpoch,
  expNone,
  objectRef,
  supportedTransaction,
  u64,
  callArgImm,
  callArgPure,
  callArgReceiving,
  callArgShared,
} from './fixtures.js';

const NETWORK = { name: 'localnet' as const, identifier: '5Pvfmia24jvv3vYvgKu1qdinuichPNBs8juYrtZcgznQ' };

const POLICY: SuiValidationPolicy = {
  allowedPackages: new Set<string>(),
  maxGasBudget: 50_000_000n,
  minGasPrice: 1n,
  allowUnboundExpiry: false,
  maxCommands: 4,
};

const adapterFor = (policy = POLICY) => createSuiAdapter(policy);

// ---------------------------------------------------------------------------
// The fixture has to be self-checking: an assertion about a decoded field only means
// something if the bytes said that field. `addrWire`/`addrPure` disagree on endianness by
// design, so both directions are pinned here before anything built on them is trusted.
// ---------------------------------------------------------------------------

describe('the fixture writer matches the decoder it is tested against', () => {
  it('builds the supported transaction without the reader losing alignment', () => {
    const bytes = supportedTransaction({ fromGasCoin: true });
    // 2 header + [1 + 10 + 34] inputs + [1 + 6 + 8] commands + 32 sender + (1 + 72) gas
    // + 32 owner + 8 price + 8 budget + (1 + 8) expiration = 224.
    expect(bytes.byteLength).toBe(224);
    const result = adapterFor().decode(bytes, NETWORK, NO_EVIDENCE);
    expect(result.supported).toBe(true);
    if (!result.supported) {
      throw new Error(`fixture did not validate: ${result.reason} — ${result.detail}`);
    }
  });

  it('lays a Pure address out little-endian and an object id big-endian', () => {
    // A writer and a reader that are both "wrong" about endianness agree perfectly, so the two
    // orders are asserted apart rather than once.
    expect(addrPure(RECIPIENT)[0]).toBe(addrWire(RECIPIENT)[31]);
    expect(addrPure(RECIPIENT)).not.toEqual(addrWire(RECIPIENT));
    expect(addrWire(COIN).length).toBe(32);
    expect(objectRef(COIN, 4n, COIN).length).toBe(72);
  });
});

describe('the composed adapter accepts the one shape it claims', () => {
  it('validates a native-SUI transfer built from the gas coin', () => {
    const result = adapterFor().decode(supportedTransaction({ fromGasCoin: true }), NETWORK, NO_EVIDENCE);
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;

    expect(result.chain).toBe('sui');
    expect(result.network).toEqual(NETWORK);
    expect(result.signer).toBe(SENDER);
    expect(result.effects).toHaveLength(2);
    const [transfer, fee] = result.effects;
    expect(transfer).toMatchObject({ kind: 'transfer', amountRaw: 1_000_000n, from: SENDER, to: RECIPIENT });
    // The gas path's padded literal must come out canonical, or a policy naming `0x2::sui::SUI`
    // never matches and the denial reads like a policy decision instead of a string comparison.
    expect(transfer!.asset).toMatchObject({ kind: 'sui_coin', typeTag: '0x2::sui::SUI' });
    expect(fee).toMatchObject({ kind: 'fee', maxAmountRaw: 5_000_000n, paidBy: SENDER });
    expect(result.producedBy).toEqual({ adapter: 'chain-sui', decoderVersion: SUI_DECODER_VERSION });
    expect(result.authorities).toEqual([]);
  });

  it('validates a transfer out of a named coin object, using the supplied evidence', () => {
    const result = adapterFor().decode(supportedTransaction(), NETWORK, coinEvidence());
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.effects[0]!.asset).toMatchObject({ kind: 'sui_coin', typeTag: '0x2::sui::SUI' });
    expect(result.stateDependencies).toHaveLength(1);
    expect(result.stateDependencies[0]!.id).toBe(COIN);
    // The dependency's hash is recomputed from the bytes the adapter read, not copied from the
    // caller's `contentHash`, which is all zeros here on purpose.
    expect(result.stateDependencies[0]!.contentHash).not.toBe('0'.repeat(64));
    expect(result.stateDependencies[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-derives the digests the signing boundary would, from the same bytes', () => {
    const bytes = supportedTransaction();
    const result = adapterFor().decode(bytes, NETWORK, coinEvidence());
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.txDigest).toBe(transactionDigestOf(bytes));
    // The two are different values over the same bytes: one is what Sui indexes effects by, the
    // other is what the signature covers. A signer that checked the wrong one signs unchecked bytes.
    expect(result.signingDigest).not.toBe(result.txDigest);
    expect(result.signingDigest).toBe(adapterFor().signingDigestOf(bytes));
    expect(digestHex(result.signingDigest)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('moves the digest when a security-relevant field moves — operation substitution', () => {
    const base = adapterFor().decode(supportedTransaction(), NETWORK, coinEvidence());
    const doubled = adapterFor().decode(supportedTransaction({ amountRaw: 2_000_000n }), NETWORK, coinEvidence());
    const rerouted = adapterFor().decode(
      supportedTransaction({ recipient: OTHER }),
      NETWORK,
      coinEvidence(),
    );
    if (!isSupported(base) || !isSupported(doubled) || !isSupported(rerouted)) {
      throw new Error('one of the variants failed to validate, so the substitution claim is vacuous');
    }
    // A sealed ticket cannot be spent on the doubled amount or the different recipient, because
    // both produce a signing digest the ticket does not name.
    expect(doubled.signingDigest).not.toBe(base.signingDigest);
    expect(rerouted.signingDigest).not.toBe(base.signingDigest);
    expect(doubled.signingDigest).not.toBe(rerouted.signingDigest);
    expect(doubled.effects[0]).toMatchObject({ amountRaw: 2_000_000n });
    expect(rerouted.effects[0]).toMatchObject({ to: OTHER });
  });

  it('binds the epoch the bytes carry, and no other', () => {
    const result = adapterFor().decode(supportedTransaction({ expiration: expEpoch(500n) }), NETWORK, coinEvidence());
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.expiry).toEqual({ domain: 'sui_epoch', maxEpoch: 500n, chainBound: false });
  });
});

describe('each named danger construct is refused, and never by silence', () => {
  const other = OTHER;

  const cases: readonly [string, Uint8Array, string][] = [
    ['expiration None, which carries no network binding', supportedTransaction({ expiration: expNone() }), 'EXPIRY_UNBOUNDED'],
    ['a zero gas price, i.e. a sponsored transaction', supportedTransaction({ gas: { price: 0n } }), 'ARGUMENT_UNRESOLVED'],
    ['a gas budget above the policy maximum', supportedTransaction({ gas: { budget: 9_000_000_000n } }), 'AUTHORITY_EXERCISED'],
    ['no gas payment objects', supportedTransaction({ gas: { payment: [] } }), 'ARGUMENT_UNRESOLVED'],
    ['three commands', supportedTransaction({
      commands: [
        cmdSplitCoins(argGas(), [argInput(0)]),
        cmdTransferObjects([argResult(0)], argInput(1)),
        cmdMergeCoins(argGas(), [argResult(0)]),
      ],
    }), 'OPERATION_UNSUPPORTED'],
    ['a MoveCall in place of the split', supportedTransaction({
      commands: [
        cmdMoveCall(mkAddress('05'), 'coin', 'transfer', [], [argInput(0)]),
        cmdTransferObjects([argResult(0)], argInput(1)),
      ],
    }), 'OPERATION_UNSUPPORTED'],
    ['the object moved is a NestedResult', supportedTransaction({
      commands: [
        cmdSplitCoins(argGas(), [argInput(0)]),
        cmdTransferObjects([argNested(0, 0)], argInput(1)),
      ],
    }), 'OPERATION_UNSUPPORTED'],
    ['the object moved is an input, not the split result', supportedTransaction({
      commands: [
        cmdSplitCoins(argGas(), [argInput(0)]),
        cmdTransferObjects([argInput(2)], argInput(1)),
      ],
    }), 'OPERATION_UNSUPPORTED'],
    ['two objects in one TransferObjects', supportedTransaction({
      commands: [
        cmdSplitCoins(argGas(), [argInput(0)]),
        cmdTransferObjects([argResult(0), argResult(0)], argInput(1)),
      ],
    }), 'OPERATION_UNSUPPORTED'],
    ['two amounts from one SplitCoins', supportedTransaction({
      commands: [
        cmdSplitCoins(argGas(), [argInput(0), argInput(0)]),
        cmdTransferObjects([argResult(0)], argInput(1)),
      ],
    }), 'OPERATION_UNSUPPORTED'],
    ['a zero amount', supportedTransaction({ amountRaw: 0n }), 'OPERATION_UNSUPPORTED'],
    ['a recipient whose Pure is not 32 bytes', supportedTransaction({
      inputs: [callArgPure(u64(1_000_000n)), callArgPure(addrPure(RECIPIENT).slice(0, 20)), callArgImm(COIN, 4n, COIN)],
    }), 'ARGUMENT_UNRESOLVED'],
    ['a FundsWithdrawal (SIP-58 address-balance) argument', supportedTransaction({
      // `decode.ts` models `CallArg::FundsWithdrawal` as a bare variant tag with no payload — it
      // refuses the third variant by name without interpreting it, so the fixture carries no body.
      inputs: [callArgPure(u64(1_000_000n)), callArgPure(addrPure(RECIPIENT)), [2]],
    }), 'OPERATION_UNSUPPORTED'],
    ['a Receiving reference to an object the sender never fetched', supportedTransaction({
      inputs: [callArgPure(u64(1_000_000n)), callArgPure(addrPure(RECIPIENT)), callArgReceiving(COIN, 4n, COIN)],
    }), 'OPERATION_UNSUPPORTED'],
    ['a shared object as the coin', supportedTransaction({
      inputs: [callArgPure(u64(1_000_000n)), callArgPure(addrPure(RECIPIENT)), callArgShared(COIN, 1n)],
    }), 'OPERATION_UNSUPPORTED'],
  ];

  for (const [label, bytes, reason] of cases) {
    it(`refuses ${label} with ${reason}`, () => {
      const result = adapterFor().decode(bytes, NETWORK, coinEvidence());
      expect(result.supported).toBe(false);
      if (result.supported) return;
      expect(result.reason).toBe(reason);
      // The refusal says what it looked at. An audit trail that reads `unsupported` alone is not an
      // answer an operator can act on, and not evidence a reviewer can retrace.
      expect(result.detail.length).toBeGreaterThan(10);
      expect(typeof result.partiallyParsed).toBe('boolean');
    });
  }

  it('refuses a coin the evidence says the sender no longer owns', () => {
    const result = adapterFor().decode(supportedTransaction(), NETWORK, coinEvidence('0x2::coin::Coin<0x2::sui::SUI>', other));
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('STATE_STALE');
  });

  it('refuses a coin the evidence says cannot cover the amount', () => {
    const result = adapterFor().decode(
      supportedTransaction({ amountRaw: 500_000n }),
      NETWORK,
      coinEvidence('0x2::coin::Coin<0x2::sui::SUI>', SENDER, '499_999'.replace(/_/g, '')),
    );
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('STATE_STALE');
  });

  it('refuses with no evidence at all rather than assuming the coin type', () => {
    const result = adapterFor().decode(supportedTransaction(), NETWORK, NO_EVIDENCE);
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('ARGUMENT_UNRESOLVED');
    // The bytes parsed fine — which is precisely why a partially-parsed flag has to be set: the
    // fields that did decode look trustworthy to whoever reads the record next.
    expect(result.partiallyParsed).toBe(true);
  });

  it('refuses a MakeMoveVec smuggled into the command pair', () => {
    const result = adapterFor().decode(supportedTransaction({
      commands: [
        cmdMakeMoveVec([argInput(0)]),
        cmdTransferObjects([argResult(0)], argInput(1)),
      ],
    }), NETWORK, NO_EVIDENCE);
    expect(result.supported).toBe(false);
  });
});

describe('the gas-coin path does not silently mean "native SUI" when it cannot prove it', () => {
  it('uses the sender as the source, since the gas coin is the sender-owned coin', () => {
    const result = adapterFor().decode(supportedTransaction({ fromGasCoin: true }), NETWORK, NO_EVIDENCE);
    expect(isSupported(result)).toBe(true);
    if (!isSupported(result)) return;
    expect(result.effects[0]).toMatchObject({ from: SENDER });
    // No object was read, so nothing is pinned. A dependency naming the gas coin with
    // `sha256('')` would read to reconciliation as a checked fact about an object nobody looked at.
    expect(result.stateDependencies).toHaveLength(0);
  });
});

describe('decode is total', () => {
  it('never throws, across random, truncated and oversized inputs', () => {
    const adapter = adapterFor();
    const probes: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array(131_073),
      Uint8Array.from(Buffer.alloc(MAX_SUI_TX_BYTES + 1, 0xff)),
      supportedTransaction().slice(0, 20),
      supportedTransaction().subarray(0, supportedTransaction().byteLength - 1),
    ];
    for (let i = 0; i < 400; i += 1) {
      probes.push(Uint8Array.from(Array.from({ length: (i * 37) % 240 }, () => Math.floor(Math.random() * 256))));
    }
    for (const probe of probes) {
      const result = adapter.decode(probe, NETWORK, coinEvidence());
      expect(typeof result.supported).toBe('boolean');
      if (!result.supported) {
        expect(typeof result.reason).toBe('string');
        expect(typeof result.detail).toBe('string');
      }
    }
  });

  it('bounds the payload before the reader loops over it', () => {
    const result = adapterFor().decode(new Uint8Array(MAX_SUI_TX_BYTES + 1), NETWORK, coinEvidence());
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toBe('FORMAT_UNSUPPORTED');
    expect(result.partiallyParsed).toBe(false);
  });

  it('signingDigestOf seals a digest for any bytes, and never a malformed one', () => {
    const empty = adapterFor().signingDigestOf(new Uint8Array(0));
    expect(empty).not.toBeNull();
    expect(ChainTransactionDigest.parse(empty!)).toBe(empty);
    const real = adapterFor().signingDigestOf(supportedTransaction());
    expect(real).not.toBeNull();
    expect(real).not.toBe(empty);
  });
});

describe('capabilities describe this build, not the interface it satisfies', () => {
  it('derives bindsNetwork from the expiry policy rather than asserting it', () => {
    expect(suiCapabilities(POLICY).bindsNetwork).toBe(true);
    const permissive = { ...POLICY, allowUnboundExpiry: true };
    expect(suiCapabilities(permissive).bindsNetwork).toBe(false);
    // A deployment that accepts unbound expiry has given up network binding, and a policy that
    // requires it is now refused at startup instead of being silently unenforced at request time.
    const gap = checkCapabilities(suiCapabilities(permissive), ['bindsNetwork']);
    expect(gap).not.toBeNull();
    expect(gap!.missing).toContain('bindsNetwork');
  });

  it('declares what the offline decoder is not', () => {
    const declared = suiCapabilities(POLICY);
    expect(declared.canSimulate).toBe(false);
    expect(declared.canVerifySettlement).toBe(false);
    expect(declared.resolvesAuthorityEffects).toBe(false);
    expect(declared.resolvesReferences).toBe(false);
    expect(declared.decodesOffline).toBe(true);
    expect(declared.computesSigningDigest).toBe(true);
    expect(declared.identifiesAssets).toBe(true);
    const gap = checkCapabilities(declared, ['canSimulate', 'identifiesAssets']);
    expect(gap).not.toBeNull();
    expect(gap!.missing).toEqual(['canSimulate']);
  });

  it('accepts a policy that asks only for what the adapter promises', () => {
    expect(checkCapabilities(suiCapabilities(POLICY), ['identifiesAssets', 'bindsNetwork'])).toBeNull();
  });

  it('the adapter object carries the same capability set the function computes', () => {
    const adapter = adapterFor();
    expect(adapter.capabilities).toEqual(suiCapabilities(POLICY));
    expect(adapter.chain).toBe('sui');
    expect(adapter.name).toBe('chain-sui');
    expect(adapter.maxBytes).toBe(MAX_SUI_TX_BYTES);
  });
});

describe('asset identity is normalized without folding case that matters', () => {
  it('shortens padded addresses', () => {
    expect(normalizeTypeTag(`0x${'0'.repeat(63)}2::sui::SUI`)).toBe('0x2::sui::SUI');
    // Hex address digits are case-folded (they denote the same bytes); the module and struct
    // names are not, which is the half that must stay distinct.
    expect(normalizeTypeTag('0x000A::mod::Name')).toBe('0xa::mod::Name');
  });

  it('keeps struct names case-sensitive, so two assets stay two assets', () => {
    // The first version of this path ran `toLowerCase()` over the whole tag, which folded
    // `0x3::tkn::USDC` and `0x3::tkn::usdc` into one asset identity — and a policy allowlisting
    // one would have authorized the other.
    const upper = normalizeTypeTag('0x000003::tkn::USDC');
    const lower = normalizeTypeTag('0x3::tkn::usdc');
    expect(upper).toBe('0x3::tkn::USDC');
    expect(lower).toBe('0x3::tkn::usdc');
    expect(upper).not.toBe(lower);
  });

  it('leaves an address that is genuinely zero alone', () => {
    expect(normalizeTypeTag(`0x${'0'.repeat(64)}::x::Y`)).toBe('0x0::x::Y');
  });
});
