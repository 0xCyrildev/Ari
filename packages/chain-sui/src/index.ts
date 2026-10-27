/**
 * The Sui adapter as `@ari/chain-core`'s `ChainAdapter`: one entry point, capabilities that
 * describe what this build actually does, and no path that throws a permissive answer.
 *
 * `decodeTransactionData` (parse) and `validateSuiTransaction` (classify) stayed separate because
 * a parse succeeds on far more transactions than can be authorized. This file is where they
 * compose, and where the composition gets the two properties neither half has alone:
 *
 *   1. **Totality.** `ChainAdapter.decode` never throws. Every escape — a malformed byte string, an
 *      oversized payload, a hash that came out the wrong length — becomes an `Unsupported` naming
 *      its reason, because a thrown error on the decision path is read by a route handler as "no
 *      decision was made" rather than "the answer is no".
 *   2. **Honest capabilities.** The capability set is *derived from the validation policy*, not
 *      written as a constant. That matters for exactly one capability: `bindsNetwork`. A Sui
 *      transaction whose `expiration` is `None` carries no chain identifier, so a deployment that
 *      sets `allowUnboundExpiry: true` has knowingly given up network binding — and the capability
 *      check that a policy runs at startup must see that, or the policy keeps a guarantee the
 *      adapter can no longer provide.
 */

import {
  notSupported,
  type AdapterCapabilities,
  type ChainAdapter,
  type ChainTransactionDigest,
  type DecodeResult,
  type NetworkId,
  type StateEvidence,
} from '@ari/chain-core';
import { decodeTransactionData } from './decode.js';
import { signingDigestOf } from './digest.js';
import {
  MAX_SUI_TX_BYTES,
  SUI_ADAPTER_NAME,
  SUI_DECODER_VERSION,
  validateSuiTransaction,
  type SuiValidationPolicy,
} from './validate.js';

export function suiCapabilities(policy: SuiValidationPolicy): AdapterCapabilities {
  return {
    // Parses and classifies from bytes plus supplied evidence; issues no network call.
    decodesOffline: true,
    // Does NOT resolve references: a wrapped object's contents, or an object that is not the coin
    // evidence names, is refused rather than followed. Callers must hand over the coin's state.
    resolvesReferences: false,
    // Every supported transaction leaves with a resolved Move `TypeTag`, or is refused with
    // ARGUMENT_UNRESOLVED. An asset that is only "some object" is never reported as validated.
    identifiesAssets: true,
    // Authority exercises are refused, not enumerated. A policy that wants to *see* a capability
    // object being moved needs an adapter that models them; this one has no such transaction in
    // its supported set, so it must not be trusted to report one it did not already reject.
    resolvesAuthorityEffects: false,
    // The one capability that depends on configuration — see the header.
    bindsNetwork: policy.allowUnboundExpiry === false,
    computesSigningDigest: true,
    // No RPC in this package: simulation and settlement checks live in `@ari/simulation` and,
    // for Sui, in whatever client is wired at the authority plane.
    canSimulate: false,
    canVerifySettlement: false,
  };
}

export interface SuiAdapter extends ChainAdapter {
  readonly chain: 'sui';
  readonly policy: SuiValidationPolicy;
}

/**
 * Build the adapter for one deployment. The policy is part of the adapter's identity because the
 * refusal set depends on it: two deployments with different `allowUnboundExpiry` are not running
 * the same decoder, and `decoderVersion` alone would hide that.
 */
export function createSuiAdapter(policy: SuiValidationPolicy): SuiAdapter {
  const capabilities = suiCapabilities(policy);
  return {
    chain: 'sui',
    name: SUI_ADAPTER_NAME,
    decoderVersion: SUI_DECODER_VERSION,
    capabilities,
    policy,
    maxBytes: MAX_SUI_TX_BYTES,

    decode(serializedBytes: Uint8Array, network: NetworkId, evidence: StateEvidence): DecodeResult {
      try {
        // Bounded before the reader touches it, so a 400 MiB payload is a refusal and not an
        // allocation or a stack of loop iterations on the decision path.
        if (serializedBytes.byteLength > MAX_SUI_TX_BYTES) {
          return notSupported(
            'FORMAT_UNSUPPORTED',
            `${serializedBytes.byteLength} byte(s) exceeds the ${MAX_SUI_TX_BYTES} byte cap this adapter will read`,
            false,
          );
        }
        const decoded = decodeTransactionData(serializedBytes);
        if (!decoded.ok) {
          return notSupported(
            decoded.kind === 'MALFORMED' ? 'MALFORMED_BYTES' : 'FORMAT_UNSUPPORTED',
            decoded.detail,
            false,
          );
        }
        return validateSuiTransaction(decoded.parsed, serializedBytes, network, evidence, policy);
      } catch (error) {
        // Reaching here means a bug in this package, not a hostile transaction: `decode.ts` and
        // `validate.ts` both return refusals. It is a refusal and never a re-throw, and it is
        // `DECODER_ERROR` so the audit trail says the decoder gave up rather than the target being
        // unsupported. A `DECODER_ERROR` must never yield an ALLOW downstream.
        const message = error instanceof Error ? error.message : 'non-error thrown while decoding';
        return notSupported('DECODER_ERROR', `${SUI_ADAPTER_NAME}: ${message}`, false);
      }
    },

    signingDigestOf(serializedBytes: Uint8Array): ChainTransactionDigest | null {
      try {
        return signingDigestOf(serializedBytes);
      } catch {
        // `null` here means "the signing boundary cannot re-derive what it is being asked to
        // sign", which the caller must treat as a refusal to sign. It is not a fallback.
        return null;
      }
    },
  };
}

export {
  MAX_SUI_TX_BYTES,
  SUI_ADAPTER_NAME,
  SUI_DECODER_VERSION,
  normalizeTypeTag,
  validateSuiTransaction,
  type SuiCoinEvidence,
  type SuiValidationPolicy,
} from './validate.js';
export {
  KNOWN_VARIANTS,
  decodeTransactionData,
  type Argument,
  type CallArg,
  type Command,
  type DecodeFailure,
  type ObjectArg,
  type ObjectRef,
  type ParsedTransactionData,
  type TransactionExpiration,
  type TypeInput,
} from './decode.js';
export {
  base58Decode,
  base58Encode,
  chainIdentifierBytes,
  digestBase58,
  digestHex,
  signingDigestOf,
  transactionDigestOf,
} from './digest.js';
export { BcsError, BcsReader, toHex } from './bcs.js';

/**
 * The shared contract is re-exported so a deployment wiring two adapters imports one package and
 * cannot get two structurally-identical-but-distinct `ValidatedTransaction` types from two
 * resolutions of `@ari/chain-core`.
 */
export type {
  AdapterCapabilities,
  ChainAdapter,
  ChainTransactionDigest,
  DecodeResult,
  NetworkId,
  RequiredCapability,
  StateEvidence,
  Unsupported,
  ValidatedTransaction,
} from '@ari/chain-core';
