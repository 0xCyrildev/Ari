/**
 * The EVM adapter as `@ari/chain-core`'s `ChainAdapter`.
 *
 * The capability set is derived from the policy, as `@ari/chain-sui` does, because two of the claims
 * here are configuration rather than code:
 *
 *   - `identifiesAssets` is only true while `expectedNonce` handling and token evidence are wired. A
 *     deployment that supplies no evidence still refuses ERC-20 calls, so the claim holds — but it is
 *     the *refusal* that makes it true, and that is worth stating rather than implying.
 *   - `bindsNetwork` is true for a stronger reason than any other adapter here: EIP-155 puts the chain
 *     id *inside* the signing payload and EIP-2718 does the same for typed envelopes, so a signature
 *     cannot be replayed onto a second network at all. A pre-EIP-155 legacy envelope is refused for
 *     exactly that absence.
 */

import {
  chainDigestOf,
  notSupported,
  type AdapterCapabilities,
  type ChainAdapter,
  type ChainTransactionDigest,
  type DecodeResult,
  type NetworkId,
  type StateEvidence,
} from '@ari/chain-core';
import {
  EVM_ADAPTER_NAME,
  EVM_DECODER_VERSION,
  MAX_EVM_TX_BYTES,
  decodeEnvelope,
  decodeSigningPayload,
  keccak256,
  signingPayload,
} from './envelope.js';
import { validateEvmTransaction, type EvmValidationPolicy } from './validate.js';

export function evmCapabilities(_policy: EvmValidationPolicy): AdapterCapabilities {
  return {
    decodesOffline: true,
    // Reads no account state: balances, allowances and nonce are not resolved, and an envelope whose
    // execution depends on state this adapter did not look at is refused on other grounds.
    resolvesReferences: false,
    identifiesAssets: true,
    // Reports ERC-20 approvals as `evm_erc20_approval` exercises. Arbitrary calls — where some other
    // authority could be exercised invisibly — are outside the supported set, so the claim is "within
    // what this decodes, nothing authority-shaped is hidden", not "nothing is".
    resolvesAuthorityEffects: true,
    // EIP-155 / EIP-2718 put the chain id inside the payload a signature covers.
    bindsNetwork: true,
    computesSigningDigest: true,
    // Simulation lives in `@ari/simulation` and settlement lookup is not in this package. Declaring
    // them false here is the honest statement about *this* adapter, not about the deployment.
    canSimulate: false,
    canVerifySettlement: false,
  };
}

export interface EvmAdapter extends ChainAdapter {
  readonly chain: 'evm';
  readonly policy: EvmValidationPolicy;
}

export function createEvmAdapter(policy: EvmValidationPolicy): EvmAdapter {
  const capabilities = evmCapabilities(policy);
  return {
    chain: 'evm',
    name: EVM_ADAPTER_NAME,
    decoderVersion: EVM_DECODER_VERSION,
    capabilities,
    policy,
    maxBytes: MAX_EVM_TX_BYTES,

    decode(serializedBytes: Uint8Array, network: NetworkId, evidence: StateEvidence): DecodeResult {
      try {
        if (serializedBytes.byteLength > MAX_EVM_TX_BYTES) {
          return notSupported(
            'FORMAT_UNSUPPORTED',
            `${serializedBytes.byteLength} byte(s) exceeds the ${MAX_EVM_TX_BYTES} byte cap this adapter will read`,
            false,
          );
        }
        const decoded = decodeEnvelope(serializedBytes);
        if (!decoded.ok) {
          return notSupported(decoded.kind, decoded.detail, decoded.kind !== 'MALFORMED_BYTES');
        }
        return validateEvmTransaction(decoded.envelope, serializedBytes, network, evidence, policy);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'non-error thrown while decoding';
        return notSupported('DECODER_ERROR', `${EVM_ADAPTER_NAME}: ${message}`, false);
      }
    },

    signingDigestOf(serializedBytes: Uint8Array): ChainTransactionDigest | null {
      try {
        if (serializedBytes.byteLength > MAX_EVM_TX_BYTES) return null;
        const decoded = decodeEnvelope(serializedBytes);
        // The signing digest is recomputed from the decoded fields, never read off the envelope: a
        // caller that handed different bytes whose encoding happened to agree would otherwise get a
        // digest it could not have produced from the operation being signed.
        if (decoded.ok) return signingDigestOfPayload(signingPayload(decoded.envelope));
        // Otherwise it may be the payload a signature *will* cover — the bytes this package
        // constructs and the signer is handed. Same discipline: read the fields back, re-encode
        // canonically, hash that. Non-minimal lengths never reach the re-encode; the reader refuses
        // them (`long-form list length is zero-padded`), which `test/construct.test.ts` pins, so
        // `null` — a refusal — is the answer for a byte string that is not the canonical payload.
        const unsigned = decodeSigningPayload(serializedBytes);
        return unsigned.ok ? signingDigestOfPayload(signingPayload(unsigned.core)) : null;
      } catch {
        return null;
      }
    },
  };
}

function signingDigestOfPayload(payload: Uint8Array): ChainTransactionDigest {
  // Re-derived through the same tagged constructor the decoder used, so the two cannot drift apart.
  return chainDigestOf('evm/keccak256-signing-v1', keccak256(payload));
}

export {
  ERC20_APPROVE_SELECTOR,
  ERC20_CALL_LENGTH,
  ERC20_TRANSFER_SELECTOR,
  MAX_EVM_TX_BYTES,
  UINT256_MAX,
  validateEvmTransaction,
  type EvmTokenEvidence,
  type EvmTransactionFields,
  type EvmValidationPolicy,
} from './validate.js';
export {
  EVM_CONSTRUCTED_FORM,
  constructEip1559Payload,
  constructEvmTransaction,
  encodeErc20TransferCalldata,
  evmCallFieldsFor,
  signingRequestFor,
  type CallFieldsResult,
  type ConstructResult,
  type EvmCallFields,
  type EvmSigningRequest,
} from './construct.js';
export {
  EVM_ADAPTER_NAME,
  EVM_DECODER_VERSION,
  decodeEnvelope,
  decodeSigningPayload,
  hexAddress,
  keccak256,
  selectorOf,
  signingPayload,
  type EnvelopeCore,
  type EnvelopeFailure,
  type EvmEnvelope,
  type EnvelopeForm,
} from './envelope.js';
export {
  RlpError,
  decodeRlp,
  encodeBytes,
  encodeList,
  encodeQuantity,
  asBytes,
  asList,
  asQuantity,
  type RlpItem,
} from './rlp.js';
export type {
  AdapterCapabilities,
  ChainAdapter,
  ChainTransactionDigest,
  DecodeResult,
  NetworkId,
  StateEvidence,
  Unsupported,
  ValidatedTransaction,
} from '@ari/chain-core';
