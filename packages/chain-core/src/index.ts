/**
 * The one barrel for the shared chain contract.
 *
 * A zod schema declared as `export const X = z.…` alongside `export type X = z.infer<typeof X>`
 * is re-exported in **both** meanings by a plain `export { X }`, so the inferred types
 * (`Asset`, `Effect`, `Expiry`, `NetworkId`, `StateDependency`, `ValidatedTransaction`, …) are
 * listed once, as values. The block below carries only the names that have no runtime object —
 * adding a schema to it is a `TS2300: Duplicate identifier`, which is how this sentence was
 * written rather than assumed.
 */
export {
  AdapterCapabilities,
  Asset,
  AuthorityExercise,
  ChainDigestAlgorithm,
  ChainTransactionDigest,
  Effect,
  Expiry,
  NetworkId,
  NON_NEGOTIABLE,
  RequiredCapability,
  StateDependency,
  UnsupportedReason,
  ValidatedTransaction,
  chainDigestBytes,
  chainDigestOf,
  chainOfDigest,
  checkCapabilities,
  isSupported,
  notSupported,
} from './adapter.js';
export type {
  CapabilityGap,
  ChainAdapter,
  DecodeResult,
  StateEvidence,
  Unsupported,
} from './adapter.js';

export {
  CONSERVATIVE_SLOT_MILLIS,
  ConstructionSite,
  SOLANA_BLOCKHASH_SLOTS,
  chainValidityWindowMs,
  chooseConstructionSite,
  maxTicketTtlMs,
} from './expiry.js';
export type { BindingDecision } from './expiry.js';
