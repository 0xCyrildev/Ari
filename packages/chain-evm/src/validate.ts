/**
 * The EVM supported set, and the refusals that define it.
 *
 * An EVM `data` field is an ABI blob whose meaning depends on the code at `to`. Establishing "what
 * this transaction does" for an arbitrary call means establishing the semantics of arbitrary bytecode
 * at request time, which is not a question a payment policy can answer. So this adapter supports three
 * shapes — a native transfer, an ERC-20 `transfer`, and an ERC-20 `approve` — and refuses everything
 * else by naming what it saw, exactly as `@ari/chain-sui` does for one PTB shape.
 *
 * Three decisions here are load-bearing:
 *
 *   1. **`approve` is not a transfer.** It moves nothing and grants a *continuing* ability to move up
 *      to an amount, and `type(uint256).max` is the common idiom. It therefore becomes its own
 *      `Effect` kind (`approval`, naming `owner` and `spender`) and its own `AuthorityExercise`, so a
 *      policy that bounds outflows cannot satisfy itself against a grant that has no outflow yet, and
 *      a policy that watches authority changes cannot miss the one that is also an amount.
 *   2. **Calldata plus `value` is refused, not interpreted.** A call that also carries native coin does
 *      two things in one envelope, and only the bytecode at `to` knows how the value is used. There is
 *      no single policy line to bind it to.
 *   3. **The sender is not derived from these bytes.** An EVM transaction's `from` is recovered from
 *      the signature, and this build performs no ECDSA recovery, so `signer` is the address the
 *      *deployment* is configured to sign for and the adapter says so. What actually holds is the
 *      property Ari already relies on: the signer only signs with its own key, so the sender is the
 *      wallet `SIGNER_WALLETS` names. Claiming the bytes were checked to prove that would be exactly
 *      the sort of assurance this package exists to refuse.
 */

import { notSupported, type ChainTransactionDigest, type DecodeResult, type Effect, type NetworkId, type StateEvidence } from '@ari/chain-core';
import { createHash } from 'node:crypto';
import {
  EVM_ADAPTER_NAME,
  EVM_DECODER_VERSION,
  MAX_EVM_TX_BYTES,
  hexAddress,
  selectorOf,
  type EnvelopeForm,
} from './envelope.js';

export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3';

/** `transfer(address,uint256)` and `approve(address,uint256)` are both 4 + 32 + 32. */
export const ERC20_CALL_LENGTH = 68;

/** `type(uint256).max` — the ERC-20 idiom for "spend until revoked". */
export const UINT256_MAX = (1n << 256n) - 1n;

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export interface EvmValidationPolicy {
  /** Decimal `chainId`s this deployment will sign for. Anything else is a cross-network replay. */
  readonly allowedChainIds: ReadonlySet<string>;
  /** Upper bound on `gasLimit * maxFeePerGas`, in wei. A transaction with no bounded cost is refused. */
  readonly maxFeeCostWei: bigint;
  readonly maxGasLimit: bigint;
  /**
   * The address this deployment signs from. Required rather than defaulted: leaving it out would let a
   * validated transaction report a sender nobody asserted.
   */
  readonly signerAddress: string;
  /**
   * The account nonce observed at decision time, or `null` when nothing observed it. An envelope ahead
   * of it is a transaction that cannot execute yet, which is a question of *sequence*, not of time —
   * and it is refused rather than queued, because a queued authorization is one that can be spent
   * against a nonce that has since moved.
   */
  readonly expectedNonce: bigint | null;
}

/** Token metadata, which is chain state and cannot be read off the bytes. */
export interface EvmTokenEvidence {
  readonly contract: string;
  readonly decimals: bigint;
  readonly symbol: string;
}

function tokenEvidence(evidence: StateEvidence, contract: string): EvmTokenEvidence | null {
  const entry = evidence.entries.find((candidate) => candidate.id.toLowerCase() === contract);
  if (entry === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const shape = parsed as Record<string, unknown>;
  if (typeof shape.decimals !== 'number' && typeof shape.decimals !== 'string') return null;
  if (typeof shape.symbol !== 'string' || shape.symbol === '') return null;
  try {
    return { contract, decimals: BigInt(String(shape.decimals)), symbol: shape.symbol };
  } catch {
    return null;
  }
}

/**
 * A 32-byte ABI word holding an address in its low 20 bytes. The twelve leading bytes are padding and
 * must be zero: non-zero padding is not a *different* address, it is a second byte string for one
 * destination, and an adapter that read through it would authorize a destination the signer did not
 * see. That is the canonicalization collision, arriving from the ABI instead of the wire format.
 */
function addressFromWord(data: Uint8Array, offset: number): string | null {
  if (data.byteLength < offset + 32) return null;
  for (let i = 0; i < 12; i += 1) {
    if (data[offset + i] !== 0) return null;
  }
  return hexAddress(data.subarray(offset + 12, offset + 32));
}

function uint256FromWord(data: Uint8Array, offset: number): bigint | null {
  if (data.byteLength < offset + 32) return null;
  let value = 0n;
  for (let i = offset; i < offset + 32; i += 1) value = (value << 8n) | BigInt(data[i] as number);
  return value;
}

/**
 * What `validateEvmTransaction` is asked about: the field set an EVM transaction asserts, from
 * either source.
 *
 * A decoded signed envelope fills `txDigest`; a constructed signing payload cannot have one, because
 * the transaction hash covers the signature — see `@ari/chain-core`'s note on the field. Deliberately
 * absent here is `signature`: nothing on this path reads `r`/`s`/parity, so the function that decides
 * "what does this transaction do" cannot be handed a signed envelope and pretend the signature
 * carried meaning it did not check.
 */
export interface EvmTransactionFields {
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
  readonly signingDigest: ChainTransactionDigest;
  readonly txDigest: ChainTransactionDigest | null;
}

function feeCostWei(tx: EvmTransactionFields): bigint {
  const unit = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
  return tx.gasLimit * unit;
}

function evidenceHash(evidence: StateEvidence, id: string): string {
  const entry = evidence.entries.find((candidate) => candidate.id.toLowerCase() === id);
  if (entry === undefined) {
    // Not "no content". `sha256('')` is indistinguishable from a real hash of an empty account, so a
    // silent fallback here would let reconciliation compare live state against a hash of nothing.
    throw new Error(`no evidence entry for ${id}: a state dependency cannot be recorded for state that was never read`);
  }
  return createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function networkChainId(network: NetworkId): string | null {
  return /^\d{1,39}$/.test(network.identifier) ? network.identifier : null;
}

export function validateEvmTransaction(
  tx: EvmTransactionFields,
  serializedBytes: Uint8Array,
  network: NetworkId,
  evidence: StateEvidence,
  policy: EvmValidationPolicy,
): DecodeResult {
  if (!EVM_ADDRESS.test(policy.signerAddress)) {
    return notSupported('DECODER_ERROR', `the configured signer address "${policy.signerAddress}" is not lowercase 0x + 40 hex`, false);
  }

  const declared = networkChainId(network);
  if (declared === null) {
    return notSupported('EXPIRY_UNBOUNDED', `network "${network.name}" is identified by "${network.identifier}", which is not a decimal chain id`, true);
  }
  const actual = String(tx.chainId);
  if (actual !== declared) {
    return notSupported('NETWORK_UNSUPPORTED', `envelope is signed for chainId ${actual}; this deployment is on ${declared}`, false);
  }
  if (!policy.allowedChainIds.has(actual)) {
    return notSupported('NETWORK_UNSUPPORTED', `chainId ${actual} is not in this deployment's allowed set`, false);
  }

  if (tx.gasLimit > policy.maxGasLimit) {
    return notSupported('AUTHORITY_EXERCISED', `gasLimit ${tx.gasLimit} exceeds the policy maximum ${policy.maxGasLimit}`, false);
  }
  const cost = feeCostWei(tx);
  if (cost > policy.maxFeeCostWei) {
    return notSupported('AUTHORITY_EXERCISED', `the maximum fee cost ${cost} wei exceeds the policy bound ${policy.maxFeeCostWei} wei`, false);
  }
  if (tx.maxFeePerGas === null && (tx.gasPrice === null || tx.gasPrice === 0n)) {
    return notSupported('ARGUMENT_UNRESOLVED', 'the envelope names no gas price, so its fee is not bounded by anything this policy can check', true);
  }
  if (tx.maxFeePerGas !== null && tx.maxPriorityFeePerGas !== null
    && tx.maxPriorityFeePerGas > tx.maxFeePerGas) {
    return notSupported('MALFORMED_BYTES', `maxPriorityFeePerGas ${tx.maxPriorityFeePerGas} exceeds maxFeePerGas ${tx.maxFeePerGas}`, true);
  }
  if (policy.expectedNonce !== null && tx.nonce > policy.expectedNonce) {
    return notSupported('STATE_STALE', `envelope nonce ${tx.nonce} is ahead of the observed account nonce ${policy.expectedNonce}`, false);
  }

  // Contract creation installs code the policy has never seen. Nothing about "what this does" is
  // answerable before it runs, so it is not answerable at decision time either.
  if (tx.to === null) {
    return notSupported('OPERATION_UNSUPPORTED', 'to is empty: this is contract creation, and no deployment of unreviewed bytecode is a bounded outflow', true);
  }

  const data = tx.data;
  const nativeAsset = { kind: 'native' as const, chain: 'evm' as const, unit: 'eth-wei' };
  const fee: Effect = { kind: 'fee', asset: nativeAsset, maxAmountRaw: cost, paidBy: policy.signerAddress };

  const validatedBase = {
    chain: 'evm' as const,
    network,
    txDigest: tx.txDigest,
    signingDigest: tx.signingDigest,
    bytesSha256: sha256Hex(serializedBytes),
    byteLength: BigInt(serializedBytes.byteLength),
    signer: policy.signerAddress,
    expiry: { domain: 'evm_nonce' as const, nonce: tx.nonce, chainBound: true as const },
    producedBy: { adapter: EVM_ADAPTER_NAME, decoderVersion: EVM_DECODER_VERSION },
  };

  // --- shape 1: a plain native transfer ---
  if (data.byteLength === 0) {
    if (tx.value === 0n) {
      return notSupported('OPERATION_UNSUPPORTED', 'a zero-value call with no calldata moves nothing', false);
    }
    return {
      ...validatedBase,
      supported: true,
      effects: [
        { kind: 'transfer', asset: nativeAsset, amountRaw: tx.value, from: policy.signerAddress, to: tx.to },
        fee,
      ],
      authorities: [],
      stateDependencies: [],
    };
  }

  if (tx.value > 0n) {
    return notSupported('OPERATION_UNSUPPORTED',
      `${data.byteLength} byte(s) of calldata alongside a ${tx.value} wei transfer: one envelope doing two things `
      + 'cannot be attributed to one policy line, and only the bytecode at to knows how the value is used', true);
  }

  const selector = selectorOf(data);
  if (selector !== ERC20_TRANSFER_SELECTOR && selector !== ERC20_APPROVE_SELECTOR) {
    return notSupported('OPERATION_UNSUPPORTED',
      `calldata selects ${selector === '0x' ? 'fewer than four bytes' : selector}, which is outside the supported set (${ERC20_TRANSFER_SELECTOR} transfer, ${ERC20_APPROVE_SELECTOR} approve)`, false);
  }
  if (data.byteLength !== ERC20_CALL_LENGTH) {
    return notSupported('MALFORMED_BYTES', `${selector} with ${data.byteLength} byte(s): transfer(address,uint256) and approve(address,uint256) are both ${ERC20_CALL_LENGTH}`, true);
  }

  const isApproval = selector === ERC20_APPROVE_SELECTOR;
  const target = addressFromWord(data, 4);
  if (target === null) {
    return notSupported('MALFORMED_BYTES', `the address word at offset 4 is not a left-padded 20-byte address`, true);
  }
  const amountRaw = uint256FromWord(data, 36);
  if (amountRaw === null) {
    return notSupported('MALFORMED_BYTES', 'the amount word at offset 36 is truncated', true);
  }

  const token = tokenEvidence(evidence, tx.to);
  if (token === null) {
    return notSupported('ARGUMENT_UNRESOLVED',
      `no token metadata evidence for ${tx.to}: decimals are chain state, and a raw uint256 without them is `
      + 'an amount no policy can compare against a limit', true);
  }
  if (token.decimals < 0n || token.decimals > 36n) {
    return notSupported('ARGUMENT_UNRESOLVED', `token ${tx.to} reports ${token.decimals} decimals, outside the 0..36 range this build admits`, true);
  }

  const asset = {
    kind: 'erc20' as const,
    chain: 'evm' as const,
    contract: token.contract,
    decimals: token.decimals,
    unit: `${token.symbol.toLowerCase()}-${token.decimals}dp`,
  };

  if (!isApproval && amountRaw === 0n) {
    return notSupported('OPERATION_UNSUPPORTED', 'an ERC-20 transfer of zero moves nothing', false);
  }

  return {
    ...validatedBase,
    supported: true,
    effects: isApproval
      ? [{ kind: 'approval', asset, amountRaw, owner: policy.signerAddress, spender: target }, fee]
      : [{ kind: 'transfer', asset, amountRaw, from: policy.signerAddress, to: target }, fee],
    authorities: isApproval
      ? [{
        kind: 'evm_erc20_approval' as const,
        token: token.contract,
        spender: target,
        owner: policy.signerAddress,
        amountRaw,
        unlimited: amountRaw === UINT256_MAX,
      }]
      : [],
    stateDependencies: [{
      kind: 'evm_token_metadata' as const,
      id: token.contract,
      contentHash: evidenceHash(evidence, token.contract),
      readAt: { slotOrEpoch: 0n, reportedBy: evidence.readBy },
    }],
  };
}

export { MAX_EVM_TX_BYTES };
