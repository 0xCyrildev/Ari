/**
 * The EVM transaction envelope: what the bytes are, what they commit to, and what is refused.
 *
 * An EVM transaction has **two** hashes that are not the same value and are both called "the
 * transaction hash" in the wild:
 *
 *   - the *signing hash* — `keccak256` over the canonical payload with the signature fields either
 *     zeroed (EIP-155: `chainId, 0, 0`) or absent (typed transactions). This is what the signature
 *     covers, so it is what a signer must recompute before it signs anything;
 *   - the *transaction hash* — `keccak256` over the complete encoded envelope, including `r`, `s`
 *     and the parity byte. This is what a node indexes the receipt by, so it is what outcome
 *     verification looks up.
 *
 * The two coincide only by accident, and a policy that sealed the second could not be checked by a
 * signer that computes the first. Both are carried on the validated transaction and tagged with which
 * one they are — which is why `@ari/chain-core` names the algorithm inside the digest string instead
 * of passing round a bare 32 bytes.
 *
 * **This file decodes; `construct.ts` builds.** Both paths meet on the signing payload, and neither
 * invents a transaction hash. An unsigned envelope has no transaction hash, because the hash covers
 * the signature — so `ValidatedTransaction.txDigest` is **nullable**, decided on 2026-10-27 rather
 * than left as the open item this header used to record, and what binds a ticket pre-signature is
 * `signingDigest` plus `bytesSha256`, both fully determined before anybody signs. Putting the signing
 * hash in the `txDigest` slot was the tempting wrong answer: it would hand reconciliation a receipt
 * lookup key that resolves to nothing, forever, and a missing receipt read back as a bug in the
 * lookup rather than as the absence of a transaction.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { chainDigestOf, type ChainTransactionDigest } from '@ari/chain-core';
import {
  RlpError,
  asBytes,
  asList,
  asQuantity,
  decodeRlp,
  encodeBytes,
  encodeList,
  encodeQuantity,
  type RlpItem,
} from './rlp.js';

export const EVM_DECODER_VERSION = 'evm-decode/v1' as const;
export const EVM_ADAPTER_NAME = 'chain-evm' as const;

/** 100 KiB is above every realistic transfer and far below what a request should be made to parse. */
export const MAX_EVM_TX_BYTES = 102_400;

const ADDRESS_LEN = 20;

export type EnvelopeForm = 'legacy' | 'eip1559';

export interface EvmEnvelope {
  readonly form: EnvelopeForm;
  /** Present on every envelope this function returns: a pre-EIP-155 signature is refused. */
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly gasLimit: bigint;
  readonly gasPrice: bigint | null;
  readonly maxFeePerGas: bigint | null;
  readonly maxPriorityFeePerGas: bigint | null;
  /** `null` is contract creation, and `to` is lowercase hex when present. */
  readonly to: string | null;
  readonly value: bigint;
  readonly data: Uint8Array;
  readonly signature: { readonly vOrYParity: bigint; readonly r: bigint; readonly s: bigint };
  readonly signingDigest: ChainTransactionDigest;
  readonly txDigest: ChainTransactionDigest;
}

export type EnvelopeFailureKind = 'MALFORMED_BYTES' | 'FORMAT_UNSUPPORTED' | 'OPERATION_UNSUPPORTED';

export type EnvelopeFailure =
  | { readonly ok: false; readonly kind: EnvelopeFailureKind; readonly detail: string }
  | { readonly ok: true; readonly envelope: EvmEnvelope };

/**
 * The failure half on its own. `EnvelopeFailure` names the whole result of `decodeEnvelope` — it
 * carries the success case too — so reusing it as the *failure* arm of another function leaves the
 * caller unable to narrow: after `if (!result.ok)`, `{ ok: true; envelope }` is still in the type.
 */
export type EnvelopeReadFailure = {
  readonly ok: false;
  readonly kind: EnvelopeFailureKind;
  readonly detail: string;
};

/** Fields of an envelope before either digest exists — the shape the signing payload is built from. */
export interface EnvelopeCore {
  readonly form: EnvelopeForm;
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly gasLimit: bigint;
  readonly gasPrice: bigint | null;
  readonly maxFeePerGas: bigint | null;
  readonly maxPriorityFeePerGas: bigint | null;
  readonly to: string | null;
  readonly value: bigint;
  readonly data: Uint8Array;
}

function addressOf(item: RlpItem | undefined, what: string): string | null {
  const bytes = asBytes(item, what);
  if (bytes.byteLength === 0) return null;
  if (bytes.byteLength !== ADDRESS_LEN) {
    throw new RlpError('OUT_OF_RANGE', `${what} is ${bytes.byteLength} byte(s), not a 20-byte address`);
  }
  // Lowercased on the way out, because `@ari/schemas`' `EvmAddress` admits only lowercase hex and a
  // checksummed (EIP-55) value here would never equal the policy's own address.
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function bytesOfAddress(address: string): Uint8Array {
  return new Uint8Array(Buffer.from(address.slice(2), 'hex'));
}

/** Lowercase `0x` + 40 hex from exactly 20 bytes — the only form `@ari/schemas`' `EvmAddress` admits. */
export function hexAddress(bytes: Uint8Array): string | null {
  if (bytes.byteLength !== ADDRESS_LEN) return null;
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function keccak256(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

/** `0x` + the first four bytes of `keccak256(signature)`, which is what `data` selects on. */
export function selectorOf(data: Uint8Array): string {
  if (data.byteLength < 4) return '0x';
  return `0x${Buffer.from(data.subarray(0, 4)).toString('hex')}`;
}

function digestOf(bytes: Uint8Array, algorithm: 'evm/keccak256-signing-v1' | 'evm/keccak256-txhash-v1'): ChainTransactionDigest {
  return chainDigestOf(algorithm, keccak_256(bytes));
}

/**
 * Re-encode the payload a signature covers. For legacy that is the nine-field list with
 * `chainId, 0, 0` in place of `v, r, s` — EIP-155's definition, and what every node recomputes.
 * Dropping the chain id is the pre-155 replay vector, so a legacy envelope whose `v` does not encode
 * one never reaches here.
 */
export function signingPayload(core: EnvelopeCore): Uint8Array {
  const toBytes = core.to === null ? new Uint8Array(0) : bytesOfAddress(core.to);
  if (core.form === 'legacy') {
    return new Uint8Array(encodeList([
      encodeQuantity(core.nonce),
      encodeQuantity(core.gasPrice ?? 0n),
      encodeQuantity(core.gasLimit),
      encodeBytes(toBytes),
      encodeQuantity(core.value),
      encodeBytes(core.data),
      encodeQuantity(core.chainId),
      encodeQuantity(0n),
      encodeQuantity(0n),
    ]));
  }
  // EIP-2718: the type byte prefixes the payload, inside the hash and not just the encoding.
  return new Uint8Array([0x02, ...encodeList([
    encodeQuantity(core.chainId),
    encodeQuantity(core.nonce),
    encodeQuantity(core.maxPriorityFeePerGas ?? 0n),
    encodeQuantity(core.maxFeePerGas ?? 0n),
    encodeQuantity(core.gasLimit),
    encodeBytes(toBytes),
    encodeQuantity(core.value),
    encodeBytes(core.data),
    encodeList([]),
  ])]);
}

const fail = (kind: EnvelopeFailureKind, detail: string): EnvelopeReadFailure => ({ ok: false, kind, detail });

function decodeLegacy(fields: readonly RlpItem[], raw: Uint8Array): EnvelopeFailure {
  if (fields.length !== 9) {
    return fail('FORMAT_UNSUPPORTED', `a legacy envelope has ${fields.length} fields, not the 9 (nonce..s) it must`);
  }
  const core: EnvelopeCore = {
    form: 'legacy',
    chainId: 0n,
    nonce: asQuantity(fields[0], 'nonce'),
    gasLimit: asQuantity(fields[2], 'gasLimit'),
    gasPrice: asQuantity(fields[1], 'gasPrice'),
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    to: addressOf(fields[3], 'to'),
    value: asQuantity(fields[4], 'value'),
    data: asBytes(fields[5], 'data'),
  };
  const v = asQuantity(fields[6], 'v');
  const r = asQuantity(fields[7], 'r');
  const s = asQuantity(fields[8], 's');

  // EIP-155: `v = chainId * 2 + 35` when yParity is 0 and `+ 36` when it is 1. So `chainId` is
  // `(v - 35) / 2` under truncating division and the parity is the remainder — **both** values of
  // `(v - 35) % 2` are legal. Requiring the remainder to be zero, as the first version here did,
  // refused every legacy transaction signed with yParity 1: anvil's own transfer, `v = 0xf4f6`, came
  // back "not an EIP-155 parity encoding". Only bytes from a real signer could have shown that.
  // `27`/`28` is the pre-155 form, whose signature is valid on every network the same key ever
  // reached — refused rather than "bound to the deployment's configured chain", because the bytes
  // themselves assert nothing.
  let chainId: bigint | null = null;
  if (v >= 35n) {
    chainId = (v - 35n) / 2n;
  } else if (v === 27n || v === 28n) {
    return fail('FORMAT_UNSUPPORTED',
      'a pre-EIP-155 legacy signature (v=27 or 28) carries no chain id, so the same bytes are valid on '
      + 'every network this key can reach; no authorization can bind it to one');
  } else {
    return fail('MALFORMED_BYTES', `legacy v=${v} is neither EIP-155 (>= 35) nor pre-155 (27 or 28)`);
  }
  if (chainId === null) return fail('MALFORMED_BYTES', 'unreachable: EIP-155 chain id decoding');

  const bound: EnvelopeCore = { ...core, chainId };
  return {
    ok: true,
    envelope: {
      ...bound,
      signature: { vOrYParity: v, r, s },
      signingDigest: digestOf(signingPayload(bound), 'evm/keccak256-signing-v1'),
      txDigest: digestOf(raw, 'evm/keccak256-txhash-v1'),
    },
  };
}

function decodeTyped(typeId: number, fields: readonly RlpItem[], raw: Uint8Array): EnvelopeFailure {
  if (typeId === 0x01 || typeId === 0x03 || typeId === 0x04) {
    const names: Record<number, string> = { 1: 'EIP-2930 access list', 3: 'EIP-4844 blob', 4: 'EIP-7702 delegated' };
    return fail('FORMAT_UNSUPPORTED',
      `${names[typeId]} envelopes are not decoded by this build: an access list names state the `
      + 'transaction may read or write beyond its own calls, and an EIP-7702 authorization delegates '
      + 'signing to an address the policy has no model for');
  }
  if (typeId !== 0x02) {
    return fail('FORMAT_UNSUPPORTED', `typed transaction 0x${typeId.toString(16)} is not a type this decoder knows`);
  }
  if (fields.length !== 12) {
    return fail('FORMAT_UNSUPPORTED', `an EIP-1559 envelope has ${fields.length} fields, not 12`);
  }

  const chainId = asQuantity(fields[0], 'chainId');
  const nonce = asQuantity(fields[1], 'nonce');
  const maxPriorityFeePerGas = asQuantity(fields[2], 'maxPriorityFeePerGas');
  const maxFeePerGas = asQuantity(fields[3], 'maxFeePerGas');
  const gasLimit = asQuantity(fields[4], 'gasLimit');
  const to = addressOf(fields[5], 'to');
  const value = asQuantity(fields[6], 'value');
  const data = asBytes(fields[7], 'data');
  const accessList = asList(fields[8], 'accessList');
  const yParity = asQuantity(fields[9], 'yParity');
  const r = asQuantity(fields[10], 'r');
  const s = asQuantity(fields[11], 's');

  if (accessList.length !== 0) {
    return fail('OPERATION_UNSUPPORTED',
      `an EIP-1559 envelope carrying ${accessList.length} access-list entry(ies) is refused: the list `
      + 'declares storage slots and accounts the transaction may touch, which no amount-bounded policy line describes');
  }

  const core: EnvelopeCore = {
    form: 'eip1559',
    chainId,
    nonce,
    gasLimit,
    gasPrice: null,
    maxFeePerGas,
    maxPriorityFeePerGas,
    to,
    value,
    data,
  };
  return {
    ok: true,
    envelope: {
      ...core,
      signature: { vOrYParity: yParity, r, s },
      signingDigest: digestOf(signingPayload(core), 'evm/keccak256-signing-v1'),
      txDigest: digestOf(raw, 'evm/keccak256-txhash-v1'),
    },
  };
}

/**
 * Decode a complete signed envelope. Never throws: every failure is an `ok: false` carrying a reason
 * and a sentence, because a thrown error on the decision path reads to a caller as "no decision was
 * made" rather than "the answer is no".
 */
export function decodeEnvelope(bytes: Uint8Array): EnvelopeFailure {
  try {
    if (bytes.byteLength === 0) return fail('MALFORMED_BYTES', 'an empty buffer is not an RLP item');

    const first = bytes[0] as number;
    // EIP-2718: a typed envelope begins with a byte below 0x80, which legacy RLP can never produce at
    // the top level (a list header is >= 0xc0, and a single byte < 0x80 would be a one-byte string).
    const isTyped = first < 0x80;
    if (isTyped && bytes.byteLength < 2) return fail('MALFORMED_BYTES', 'a typed envelope with no payload');

    const body = isTyped ? bytes.subarray(1) : bytes;
    const fields = asList(decodeRlp(body), isTyped ? 'typed envelope payload' : 'legacy envelope');
    return isTyped ? decodeTyped(first, fields, bytes) : decodeLegacy(fields, bytes);
  } catch (error) {
    if (error instanceof RlpError) return fail('MALFORMED_BYTES', error.message);
    const message = error instanceof Error ? error.message : 'non-error thrown while decoding';
    return fail('MALFORMED_BYTES', message);
  }
}

/**
 * Decode the payload a signature *will* cover — the unsigned EIP-1559 form, before any `r`/`s`.
 *
 * This is the other half of the round trip the construction path needs. A signer handed these bytes
 * must re-derive the signing digest itself rather than trust the decision plane's, and doing that
 * means parsing what it was handed. Measured on 2026-10-27, not assumed: a payload whose outer list
 * length is written non-minimally (`0xf9 0x00 0x6f` where `0xf8 0x6f` is canonical) is **refused at
 * the reader** — `MALFORMED_BYTES: rlp: long-form list length is zero-padded` — so `signingDigestOf`
 * answers `null` and the signing boundary refuses. There is no second byte string that reaches the
 * same digest, which is why `test/construct.test.ts` pins that refusal rather than a re-encode.
 *
 * A legacy signing payload is refused, not silently supported: `@ari/chain-evm` constructs EIP-1559
 * only, and an unsigned legacy list (`… , chainId, 0, 0`) has no slot for a tip cap, so accepting it
 * here would mean constructing transactions the policy cannot bound the fee of.
 */
export function decodeSigningPayload(bytes: Uint8Array): { readonly ok: true; readonly core: EnvelopeCore } | EnvelopeReadFailure {
  try {
    if (bytes.byteLength === 0) return fail('MALFORMED_BYTES', 'an empty buffer is not a signing payload');
    const first = bytes[0] as number;
    if (first >= 0x80) {
      return fail('FORMAT_UNSUPPORTED',
        'a legacy signing payload (an RLP list with no EIP-2718 type byte) is not read by this build: it has no '
        + 'field for a tip cap, so its fee cannot be bounded the way EIP-1559 bounds it');
    }
    if (first !== 0x02) {
      return fail('FORMAT_UNSUPPORTED', `typed signing payload 0x${first.toString(16)} is not EIP-1559 (0x02)`);
    }

    const fields = asList(decodeRlp(bytes.subarray(1)), 'EIP-1559 signing payload');
    if (fields.length !== 9) {
      return fail('FORMAT_UNSUPPORTED',
        `an unsigned EIP-1559 payload has ${fields.length} field(s), not the 9 (chainId..accessList) it must; `
        + '12 would mean a signed envelope, which is decoded, not re-hashed');
    }

    const accessList = asList(fields[8], 'accessList');
    if (accessList.length !== 0) {
      return fail('OPERATION_UNSUPPORTED',
        `a signing payload declaring ${accessList.length} access-list entry(ies) is refused: the list names storage `
        + 'slots and accounts the transaction may touch, which no amount-bounded policy line describes');
    }

    return {
      ok: true,
      core: {
        form: 'eip1559',
        chainId: asQuantity(fields[0], 'chainId'),
        nonce: asQuantity(fields[1], 'nonce'),
        gasLimit: asQuantity(fields[4], 'gasLimit'),
        gasPrice: null,
        maxFeePerGas: asQuantity(fields[3], 'maxFeePerGas'),
        maxPriorityFeePerGas: asQuantity(fields[2], 'maxPriorityFeePerGas'),
        to: addressOf(fields[5], 'to'),
        value: asQuantity(fields[6], 'value'),
        data: asBytes(fields[7], 'data'),
      },
    };
  } catch (error) {
    if (error instanceof RlpError) return fail('MALFORMED_BYTES', error.message);
    const message = error instanceof Error ? error.message : 'non-error thrown while reading a signing payload';
    return fail('MALFORMED_BYTES', message);
  }
}
