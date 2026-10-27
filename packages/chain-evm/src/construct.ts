/**
 * Building the bytes a signature will cover, from a parsed candidate.
 *
 * Everything else in Ari decides *what an agent meant*: a candidate is hashed
 * (`canon/v1`), evaluated by the policy engine, and sealed into a ticket. A chain does not execute
 * an intention — it executes an envelope. The gap between the two representations is where a
 * signature can end up covering something nobody approved, so this file is where Ari closes it, and
 * the two rules below are why it exists at all.
 *
 *   1. **One encoder per shape.** The ERC-20 calldata written here is the *same* bytes
 *      `@ari/simulation` asks the node about, because it imports this function rather than keeping
 *      its own copy. If the simulated call and the signed envelope differed, the advisory answer
 *      would be evidence about a transaction that was never authorised — and `simBound` would still
 *      read as green, because it compares digests over the candidate, not over the bytes.
 *   2. **Nothing is defaulted.** A fee, a gas limit or a nonce that the candidate did not state has
 *      to come from somewhere, and "somewhere" would be this file choosing a number the human
 *      approving the payment never saw. So every field is required by the type, and a shape Ari
 *      cannot bound (a native-value transfer, an unbounded calldata) is refused rather than
 *      supplied.
 *
 * **EIP-1559 only, deliberately.** A legacy signing payload has no field for a tip cap, so its fee
 * is `gasPrice × gasLimit` — one number the agent names — while EIP-1559 charges
 * `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)`. Ari constructs the form whose cost is fully
 * bounded by fields inside the digest. Legacy envelopes are still *decoded* (a signed transaction
 * arriving for reconciliation can be legacy) and `decodeEnvelope` refuses nothing that is well
 * formed; refusing to *construct* one is a policy choice, recorded here rather than inferred from
 * an absence.
 *
 * A constructed payload has **no transaction hash**, because the hash covers the signature. So the
 * `ValidatedTransaction` this produces carries `txDigest: null`, and what binds the ticket is
 * `signingDigest` plus `bytesSha256` — both fully determined before anybody signs.
 */

import type { CandidateTransaction } from '@ari/schemas';
import {
  chainDigestOf,
  notSupported,
  type ChainTransactionDigest,
  type DecodeResult,
  type NetworkId,
  type StateEvidence,
  type UnsupportedReason,
} from '@ari/chain-core';
import { keccak256, signingPayload, decodeSigningPayload, type EnvelopeCore } from './envelope.js';
import {
  ERC20_TRANSFER_SELECTOR,
  validateEvmTransaction,
  type EvmValidationPolicy,
} from './validate.js';

export const EVM_CONSTRUCTED_FORM = 'eip1559' as const;

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Left-padded to 32 bytes, the way every ABI word is written. */
export function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

/** A lowercase address as a 32-byte ABI word. Refuses anything that is not exactly 20 bytes. */
export function addressWord(address: string): string {
  if (!ADDRESS.test(address)) throw new Error(`not a lowercase 0x + 40 hex EVM address: ${address.slice(0, 12)}…`);
  return pad32(address.slice(2));
}

function uint256Word(value: bigint): string {
  if (value < 0n) throw new Error('a uint256 word cannot be negative');
  if (value >= 1n << 256n) throw new Error(`the amount ${value} does not fit a uint256 word`);
  return pad32(value.toString(16));
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`hex calldata has an odd number of digits: ${hex.slice(0, 12)}…`);
  return new Uint8Array(Buffer.from(body, 'hex'));
}

/**
 * `transfer(address,uint256)` calldata — the one place Ari turns a claim into bytes it has never
 * seen from anyone else. Verified against `cast calldata` output in `test/construct.test.ts`, which
 * is the only check here that could notice a padding mistake: `pad32` on an already-long value
 * silently *truncates nothing and keeps everything wrong*, and a one-byte shift in an address word
 * pays someone else.
 */
export function encodeErc20TransferCalldata(recipient: string, amountRaw: bigint): string {
  return `${ERC20_TRANSFER_SELECTOR}${addressWord(recipient)}${uint256Word(amountRaw)}`;
}

/** The envelope's destination, value and calldata — what a payment *is*, in chain terms. */
export interface EvmCallFields {
  readonly to: string;
  readonly value: bigint;
  readonly data: Uint8Array;
  readonly what: 'erc20-transfer' | 'contract-call';
}

export type CallFieldsResult =
  | { readonly ok: true; readonly fields: EvmCallFields }
  | { readonly ok: false; readonly reason: UnsupportedReason; readonly detail: string };

/**
 * What to put in the envelope for this candidate.
 *
 * Total over the parsed candidate, and it refuses exactly the shapes
 * `apps/api/src/authorize.ts` refuses for the same reason: a native value that no monetary limit in
 * the policy language can bound (`CONTRACT_VALUE_NOT_PERMITTED`, and the same argument for a native
 * transfer) is not a transaction Ari can sign for, so it must not have bytes either. Inventing an
 * encoding for something the policy cannot price would be the second half of that bug.
 */
export function evmCallFieldsFor(candidate: CandidateTransaction): CallFieldsResult {
  if (candidate.kind === 'unknown') {
    return { ok: false, reason: 'OPERATION_UNSUPPORTED', detail: `unrecognised transaction: ${candidate.reason}` };
  }
  if (candidate.chain !== 'ethereum') {
    return { ok: false, reason: 'NETWORK_UNSUPPORTED', detail: `no EVM envelope for chain "${candidate.chain}"` };
  }
  if (candidate.replayProtection.scheme !== 'account_sequence') {
    return {
      ok: false,
      reason: 'FORMAT_UNSUPPORTED',
      detail: `an EVM transaction needs account_sequence replay protection, not ${candidate.replayProtection.scheme}`,
    };
  }

  if (candidate.kind === 'contract_call') {
    if (candidate.value > 0n) {
      return {
        ok: false,
        reason: 'AUTHORITY_EXERCISED',
        detail: `a contract call carrying ${candidate.value} wei of native value has no policy bound on that value `
          + '(every monetary limit is denominated in the transfer unit), so it is not signable',
      };
    }
    if (!ADDRESS.test(candidate.contract)) {
      return { ok: false, reason: 'MALFORMED_BYTES', detail: `contract ${candidate.contract} is not a lowercase EVM address` };
    }
    const data = `${candidate.selector}${candidate.calldata.slice(2)}`;
    if (!/^0x[0-9a-f]*$/.test(data)) {
      return { ok: false, reason: 'MALFORMED_BYTES', detail: 'selector and calldata must be lowercase hex' };
    }
    return { ok: true, fields: { to: candidate.contract, value: 0n, data: hexToBytes(data), what: 'contract-call' } };
  }

  if (candidate.asset.kind !== 'erc20') {
    return {
      ok: false,
      reason: 'ARGUMENT_UNRESOLVED',
      detail: `no envelope for a ${candidate.asset.kind} transfer: a native-value payment has no monetary limit `
        + 'in the policy language to bound it, and none should be invented here',
    };
  }
  return {
    ok: true,
    fields: {
      to: candidate.asset.contract,
      value: 0n,
      data: hexToBytes(encodeErc20TransferCalldata(candidate.recipient.address, candidate.amount.raw)),
      what: 'erc20-transfer',
    },
  };
}

/** The numbers the caller must state. None of them has a default, by rule 2 in the header. */
export interface EvmSigningRequest {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: Uint8Array;
}

export type ConstructResult =
  | {
      readonly ok: true;
      /** The exact bytes a signature covers: `0x02 ‖ rlp([chainId, nonce, tip, fee, gas, to, value, data, []])`. */
      readonly bytes: Uint8Array;
      readonly signingDigest: ChainTransactionDigest;
      readonly request: EvmSigningRequest;
    }
  | { readonly ok: false; readonly reason: UnsupportedReason; readonly detail: string };

/**
 * Build the signing payload and prove it reads back as what was asked.
 *
 * The round trip is the point, not the encode: this package's RLP *writer* is young, and the two
 * header-range bugs that the signed-decoding path found were only caught because anvil produced
 * bytes this file did not. A writer that disagrees with its own reader is a bug that ships as a
 * signature over unintended bytes, so the payload is re-read with `decodeSigningPayload` and every
 * field compared before anything is hashed. A mismatch is `DECODER_ERROR`, which the kernel can
 * never turn into an ALLOW.
 */
export function constructEip1559Payload(request: EvmSigningRequest): ConstructResult {
  const core: EnvelopeCore = {
    form: EVM_CONSTRUCTED_FORM,
    chainId: request.chainId,
    nonce: request.nonce,
    gasLimit: request.gasLimit,
    gasPrice: null,
    maxFeePerGas: request.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    to: request.to,
    value: request.value,
    data: request.data,
  };

  let bytes: Uint8Array;
  try {
    bytes = signingPayload(core);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'non-error thrown while encoding';
    return { ok: false, reason: 'DECODER_ERROR', detail: `cannot encode the signing payload: ${message}` };
  }

  const readBack = decodeSigningPayload(bytes);
  if (!readBack.ok) {
    return { ok: false, reason: readBack.kind, detail: `the payload this build wrote does not read back: ${readBack.detail}` };
  }
  const r = readBack.core;
  const drift: string[] = [];
  if (r.chainId !== request.chainId) drift.push(`chainId ${r.chainId} != ${request.chainId}`);
  if (r.nonce !== request.nonce) drift.push(`nonce ${r.nonce} != ${request.nonce}`);
  if (r.gasLimit !== request.gasLimit) drift.push(`gasLimit ${r.gasLimit} != ${request.gasLimit}`);
  if (r.maxFeePerGas !== request.maxFeePerGas) drift.push(`maxFeePerGas ${r.maxFeePerGas} != ${request.maxFeePerGas}`);
  if (r.maxPriorityFeePerGas !== request.maxPriorityFeePerGas) {
    drift.push(`maxPriorityFeePerGas ${r.maxPriorityFeePerGas} != ${request.maxPriorityFeePerGas}`);
  }
  if (r.to !== request.to) drift.push(`to ${r.to} != ${request.to}`);
  if (r.value !== request.value) drift.push(`value ${r.value} != ${request.value}`);
  if (Buffer.from(r.data).toString('hex') !== Buffer.from(request.data).toString('hex')) drift.push('data differs byte for byte');
  if (drift.length > 0) {
    return { ok: false, reason: 'DECODER_ERROR', detail: `the payload this build wrote decodes differently: ${drift.join('; ')}` };
  }

  return {
    ok: true,
    bytes,
    signingDigest: chainDigestOf('evm/keccak256-signing-v1', keccak256(bytes)),
    request,
  };
}

/** The signing request a parsed candidate implies, or the reason there is none. */
export function signingRequestFor(candidate: CandidateTransaction): { ok: true; request: EvmSigningRequest } | { ok: false; reason: UnsupportedReason; detail: string } {
  const call = evmCallFieldsFor(candidate);
  if (!call.ok) return call;
  if (candidate.kind === 'unknown') {
    // `evmCallFieldsFor` already refused this variant; the narrowing is for the reader, and saying
    // so beats an `as` cast that would keep compiling if the refusal above ever moved.
    return { ok: false, reason: 'OPERATION_UNSUPPORTED', detail: `unrecognised transaction: ${candidate.reason}` };
  }
  const rp = candidate.replayProtection;
  if (rp.scheme !== 'account_sequence') {
    return { ok: false, reason: 'FORMAT_UNSUPPORTED', detail: `expected account_sequence, found ${rp.scheme}` };
  }
  if (!/^\d{1,39}$/.test(rp.chainId)) {
    return { ok: false, reason: 'NETWORK_UNSUPPORTED', detail: `chainId "${rp.chainId}" is not a decimal identifier` };
  }
  return {
    ok: true,
    request: {
      chainId: BigInt(rp.chainId),
      nonce: rp.nonce,
      gasLimit: rp.gasLimit,
      maxFeePerGas: rp.maxFeePerUnit,
      maxPriorityFeePerGas: rp.maxPriorityFeePerUnit,
      to: call.fields.to,
      value: call.fields.value,
      data: call.fields.data,
    },
  };
}

/**
 * Candidate → validated transaction, through the bytes.
 *
 * The validation is `validateEvmTransaction`, the same function the signed-decoding path runs, so a
 * fee above the deployment bound, a tip above the fee cap, a chain id this deployment is not on, a
 * nonce ahead of what was observed, or an unknown shape is refused identically whichever way the
 * fields arrived. Two copies of those rules is the failure mode this package keeps refusing.
 */
export function constructEvmTransaction(
  candidate: CandidateTransaction,
  network: NetworkId,
  evidence: StateEvidence,
  policy: EvmValidationPolicy,
): DecodeResult {
  const request = signingRequestFor(candidate);
  if (!request.ok) return notSupported(request.reason, request.detail, false);

  const built = constructEip1559Payload(request.request);
  if (!built.ok) return notSupported(built.reason, built.detail, false);

  return validateEvmTransaction(
    {
      form: EVM_CONSTRUCTED_FORM,
      chainId: built.request.chainId,
      nonce: built.request.nonce,
      gasLimit: built.request.gasLimit,
      gasPrice: null,
      maxFeePerGas: built.request.maxFeePerGas,
      maxPriorityFeePerGas: built.request.maxPriorityFeePerGas,
      to: built.request.to,
      value: built.request.value,
      data: built.request.data,
      signingDigest: built.signingDigest,
      // Undefined until a signature exists — see the field's note in @ari/chain-core.
      txDigest: null,
    },
    built.bytes,
    network,
    evidence,
    policy,
  );
}
