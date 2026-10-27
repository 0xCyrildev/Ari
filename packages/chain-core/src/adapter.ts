/**
 * The chain-adapter contract, and the two things that make it safe to add a chain.
 *
 * Ari's decision path binds a digest over a *semantic* candidate — what the agent says it
 * means to do. A chain signs *bytes*. The gap between those two representations is the whole
 * security problem of multi-chain authorization, and it is not closed by hashing harder: on
 * Sui the value that gets signed is a Blake2b-256 digest over an intent message while the
 * transaction's own identifier is a different digest over a type-name-prefixed BCS body, and on
 * Solana there is no transaction hash at all — the identifier is the Ed25519 signature over the
 * serialized message. A "generic transaction hash" would be wrong on both chains, which is why
 * this file refuses to define one.
 *
 * Two rules are load-bearing, and both are expressed structurally rather than as advice:
 *
 *   1. **Uncertainty is not a field.** A `ValidatedTransaction` has no place to record "and
 *      there is something else this might do". The only way to say that is to return
 *      `Unsupported`. A decoder that could emit a partially-understood transaction with a
 *      warning would hand the policy engine a document that reads as complete, and every rule
 *      downstream would be evaluating an artifact that its own producer admitted was a guess.
 *   2. **A capability is a promise the policy engine may rely on.** Adapters declare what they
 *      can do; `requires` checks that a policy's demands are met by the adapter that is actually
 *      loaded. Without it, a weak adapter inherits a strong adapter's guarantees simply because
 *      they share an interface — which is how "we validate token extensions" survives the day
 *      someone ships an adapter that does not.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// The chain transaction digest
// ---------------------------------------------------------------------------

/**
 * Which hash, over which bytes, at which algorithm version. Tagged because a bare 32-byte
 * hex string means nothing on its own: `sha256(message)` on Solana is not a chain-recognised
 * identifier, and Sui's `TransactionDigest` is not the bytes that are signed. Two different
 * quantities with one name is the failure mode, so the name carries the algorithm.
 */
export const ChainDigestAlgorithm = z.enum([
  /** `blake2b-256("TransactionData::" ‖ bcs(TransactionData))` — Sui's transaction identifier. */
  'sui/blake2b256-txdata-v1',
  /** `blake2b-256(bcs(IntentMessage<TransactionData>))` — the bytes a Sui signature covers. */
  'sui/blake2b256-intent-v1',
  /** `sha256(serialized message)` — Ari's binding key for Solana; NOT the chain's tx id. */
  'solana/sha256-message-v1',
  /**
   * `keccak256(0x02 ‖ rlp([chainId, nonce, tipCap, feeCap, gasLimit, to, value, data, accessList]))`
   * for an EIP-1559 envelope, or the EIP-155 legacy equivalent. The payload a signature covers.
   */
  'evm/keccak256-signing-v1',
  /** `keccak256(envelope)` — what an EVM node calls the transaction hash, and indexes receipts by. */
  'evm/keccak256-txhash-v1',
]);
export type ChainDigestAlgorithm = z.infer<typeof ChainDigestAlgorithm>;

/**
 * The chain families this contract knows. Named once: it appeared as three inline
 * `z.enum(['evm','sui','solana'])` copies, and the ticket binding is the fourth place
 * that would have had to restate it — a family a caller can write that the digest tag
 * cannot produce is a refusal that never fires.
 */
export const ChainFamily = z.enum(['evm', 'sui', 'solana']);
export type ChainFamily = z.infer<typeof ChainFamily>;

const CHAIN_OF: Record<ChainDigestAlgorithm, ChainFamily> = {
  'sui/blake2b256-txdata-v1': 'sui',
  'sui/blake2b256-intent-v1': 'sui',
  'solana/sha256-message-v1': 'solana',
  'evm/keccak256-signing-v1': 'evm',
  'evm/keccak256-txhash-v1': 'evm',
};

/**
 * A branded, self-describing chain transaction digest. One constructor (`chainDigestOf`), and
 * the brand is what stops a caller computing "its own" digest of something slightly
 * different — the same disease `CanonicalDigest` was branded to prevent.
 *
 * The payload is **fixed-length lowercase hex**, on every chain, even though Sui prints base58
 * and Solana prints base58 too. That is deliberate and it was learned the hard way: a digest value
 * that keeps the chain's native rendering is a value this type then *normalizes*, and base58 is
 * case-sensitive. Lower-casing a 32-byte blake2b-256 digest measured on 200 random digests made
 * 130 of them undecodable (`L` renders as `l`, which is not in the alphabet) and the other 70
 * decode to *different bytes* — two byte strings for one digest, the exact collision the BCS reader
 * in `@ari/chain-sui` refuses on the wire. Hex is the only rendering where `toLowerCase()` is
 * lossless and idempotent, so the string that gets sealed into a ticket and compared at signing is
 * canonical. Renderings for humans are functions (`digestBase58`), not the stored form.
 */
export const ChainTransactionDigest = z
  .string()
  .regex(/^(evm|sui|solana)\/[a-z0-9-]+-v1:[0-9a-f]{64}$/, 'a chain digest is chain/algorithm:64-lowercase-hex')
  .brand('ChainTransactionDigest');
export type ChainTransactionDigest = z.infer<typeof ChainTransactionDigest>;

export function chainDigestOf(algorithm: ChainDigestAlgorithm, digestBytes: Uint8Array): ChainTransactionDigest {
  if (digestBytes.byteLength !== 32) {
    throw new Error(
      `${algorithm} is a 256-bit digest and was handed ${digestBytes.byteLength} byte(s); `
      + `a truncated or oversized hash is not the same hash`,
    );
  }
  const hex = Buffer.from(digestBytes).toString('hex');
  const digest = `${CHAIN_OF[algorithm]}/${algorithm.split('/')[1]}:${hex}`;
  return ChainTransactionDigest.parse(digest);
}

/** The 32 raw bytes a sealed digest names — for comparison against a chain's own output. */
export function chainDigestBytes(digest: ChainTransactionDigest): Uint8Array {
  const hex = digest.slice(digest.indexOf(':') + 1);
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Which chain a sealed digest belongs to — read off the tag, never trusted from a sibling field. */
export function chainOfDigest(digest: ChainTransactionDigest): ChainFamily {
  const parsed = /^([^/]+)\//.exec(digest);
  if (parsed === null) throw new Error('a chain digest without a chain tag is not a chain digest');
  const chain = parsed[1];
  if (chain !== 'sui' && chain !== 'solana' && chain !== 'evm') {
    throw new Error(`chain digest names "${chain}", which this build has no adapter for`);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/**
 * Why an adapter could not establish what a transaction does. These map onto Ari's
 * `TRANSACTION_UNKNOWN` at the boundary; they are more specific on purpose, because the audit
 * trail has to say *which* rule of the decoder gave up, and an operator answering "why was this
 * refused" deserves the same sentence the refusal was produced with.
 */
export const UnsupportedReason = z.enum([
  /** The bytes are not parseable as this chain's transaction format at all. */
  'MALFORMED_BYTES',
  /** Parseable, but a format/version this decoder does not implement (Sui V2, Solana v1). */
  'FORMAT_UNSUPPORTED',
  /** A command or instruction outside the closed supported set. */
  'OPERATION_UNSUPPORTED',
  /** Inside the supported set, but with an input whose meaning is not statically established. */
  'ARGUMENT_UNRESOLVED',
  /** A required piece of chain state was not supplied, or moved since it was read. */
  'STATE_STALE',
  /** The transaction can spend authority the policy has no model for (capabilities, delegates). */
  'AUTHORITY_EXERCISED',
  /** No expiry was declared, or it cannot be bound to the network being used. */
  'EXPIRY_UNBOUNDED',
  /** The named network is not one this adapter or deployment will sign for. */
  'NETWORK_UNSUPPORTED',
  /** The decoder itself failed. Never a fallback: this reason must never yield an ALLOW. */
  'DECODER_ERROR',
]);
export type UnsupportedReason = z.infer<typeof UnsupportedReason>;

export interface Unsupported {
  readonly supported: false;
  readonly reason: UnsupportedReason;
  /** What the decoder was looking at when it gave up, for the audit trail and the operator. */
  readonly detail: string;
  /**
   * Set when the bytes parsed but could not be *classified* — the case where a partial decode
   * is more dangerous than a failed one, because the fields that did decode look trustworthy.
   */
  readonly partiallyParsed: boolean;
}

export const notSupported = (
  reason: UnsupportedReason,
  detail: string,
  partiallyParsed = false,
): Unsupported => ({ supported: false, reason, detail, partiallyParsed });

// ---------------------------------------------------------------------------
// The validated representation
// ---------------------------------------------------------------------------

export const NetworkId = z.object({
  /** `mainnet | testnet | devnet | localnet` — a human label, and deliberately not the binding. */
  name: z.enum(['mainnet', 'testnet', 'devnet', 'localnet']),
  /**
   * The chain's own identifier, as the chain reports it: EVM's decimal `chainId`, Sui's
   * `ChainIdentifier` (a base58 checkpoint digest), Solana's genesis-hash-derived cluster id. This
   * is the field a signature is bound to; `name` is for reading. They are both required because a
   * deployment that records only `name` has recorded an operator's intention rather than a fact
   * about the network.
   */
  identifier: z.string().min(1).max(128),
});
export type NetworkId = z.infer<typeof NetworkId>;

export const Asset = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native'), chain: ChainFamily, unit: z.string().min(1).max(32) }).strict(),
  z
    .object({
      kind: z.literal('erc20'),
      chain: z.literal('evm'),
      /**
       * The token contract, lowercase `0x` + 40 hex — the same form `@ari/schemas`' `EvmAddress`
       * requires, so an adapter that produced a mixed-case or checksummed address would not match a
       * policy's own `AssetRef.contract` and the denial would read like a policy decision.
       */
      contract: z.string().regex(/^0x[0-9a-f]{40}$/),
      /** Per-chain decimals, never assumed: 6 for USDC/USDT, 18 for most others, 0 for some. */
      decimals: z.bigint().min(0n).max(36n),
      unit: z.string().min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sui_coin'),
      chain: z.literal('sui'),
      /**
       * The resolved Move `TypeTag` of the `Balance<T>` being moved — the only asset identity Sui
       * has that survives a package upgrade. `0x…::usdc::USDC`, canonicalised to its
       * `to_canonical_string` form, never the `Display` form the framework says is unstable.
       */
      typeTag: z.string().min(3).max(512),
      unit: z.string().min(1).max(32),
      decimals: z.bigint().min(0n).max(36n),
    })
    .strict(),
  z
    .object({
      kind: z.literal('spl_mint'),
      chain: z.literal('solana'),
      /** The mint address, which is the identity; the symbol is decoration and is not compared. */
      mint: z.string().min(32).max(44),
      /** Which token program owns the mint. Token and Token-2022 mints are different assets. */
      tokenProgram: z.enum(['spl_token', 'spl_token_2022']),
      unit: z.string().min(1).max(32),
      decimals: z.bigint().min(0n).max(18n),
    })
    .strict(),
]);
export type Asset = z.infer<typeof Asset>;

/**
 * One established effect. There is no variant here for "a call whose effects we could not
 * determine" — that is an `Unsupported`, by rule 1 above.
 */
export const Effect = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('transfer'),
      asset: Asset,
      amountRaw: z.bigint().min(0n),
      /** Absolute address / object owner, after any lookup-table or wrapped-object resolution. */
      from: z.string().min(1).max(256),
      to: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fee'),
      asset: Asset,
      /** An upper bound, not an estimate, and named as such: a policy bounds the maximum. */
      maxAmountRaw: z.bigint().min(0n),
      paidBy: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval'),
      asset: Asset,
      amountRaw: z.bigint().min(0n),
      /** Whose balance the spender will be able to move. */
      owner: z.string().min(1).max(256),
      /** Who is being granted that ability. */
      spender: z.string().min(1).max(256),
    })
    .strict(),]);
export type Effect = z.infer<typeof Effect>;

/**
 * Something the transaction exercises that is not a value movement. Recorded separately from
 * `effects` because it is not bounded by an amount, and every monetary limit Ari has would read
 * as satisfied. A validated transaction may carry these only when the policy has been told it
 * may: `AuthorityExercise` is why the adapter must declare `resolvesAuthorityEffects`.
 */
export const AuthorityExercise = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sui_capability'), objectType: z.string().max(512), objectId: z.string().max(80) }).strict(),
  z
    .object({
      kind: z.literal('solana_delegate'),
      delegate: z.string().max(44),
      mint: z.string().max(44),
    })
    .strict(),
  z
    .object({
      kind: z.literal('authority_change'),
      what: z.enum(['mint', 'freeze', 'close', 'transfer_hook', 'permanent_delegate', 'upgrade', 'pause']),
      newAuthority: z.string().max(64).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('evm_erc20_approval'),
      /** The token whose `allowance` mapping is being written. */
      token: z.string().regex(/^0x[0-9a-f]{40}$/),
      /** Who gains the ability to move `owner`'s balance. */
      spender: z.string().regex(/^0x[0-9a-f]{40}$/),
      owner: z.string().regex(/^0x[0-9a-f]{40}$/),
      amountRaw: z.bigint().min(0n),
      /**
       * `amountRaw === type(uint256).max`, the ERC-20 idiom for "spend until revoked". Named
       * separately because it is the case where an amount-bounded policy line is satisfied by a
       * number that is not an amount at all.
       */
      unlimited: z.boolean(),
    })
    .strict(),
]);
export type AuthorityExercise = z.infer<typeof AuthorityExercise>;

/**
 * Chain state the decision depended on, and the hash that pins it. This is what makes the
 * authorization *about* something other than the bytes: a PTB's `Pure` arguments are untyped
 * until resolved against a package that can be upgraded, and a Solana v0 message's accounts are
 * unbound until its lookup table is read. Recording the observation without its digest would be
 * documenting a hope.
 */
export const StateDependency = z.object({
  kind: z.enum([
    'evm_account',
    'evm_token_metadata',
    'sui_object',
    'sui_package',
    'sui_normalized_function',
    'solana_account',
    'solana_lookup_table',
    'solana_mint',
    'solana_program_data',
    'solana_blockhash',
  ]),
  id: z.string().min(1).max(256),
  /** sha256 of the canonical serialization of the state that was read, hex. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  readAt: z.object({ slotOrEpoch: z.bigint().min(0n), reportedBy: z.string().min(1).max(64) }),
});
export type StateDependency = z.infer<typeof StateDependency>;

/**
 * How this transaction expires, in its chain's terms. `none` is a real answer and it is a
 * dangerous one: a Sui transaction with `expiration: None` is byte-identical on every network,
 * so an authorization with no expiry domain and no chain binding is an authorization that can be
 * replayed onto a different cluster with the same key.
 */
export const Expiry = z.discriminatedUnion('domain', [
  z.object({ domain: z.literal('none') }).strict(),
  z.object({ domain: z.literal('sui_epoch'), maxEpoch: z.bigint().min(0n), chainBound: z.boolean() }).strict(),
  z.object({ domain: z.literal('sui_validity'), minEpoch: z.bigint(), maxEpoch: z.bigint(), nonce: z.bigint(), chainBound: z.literal(true) }).strict(),
  z.object({ domain: z.literal('solana_blockhash'), lastValidBlockHeight: z.bigint().min(0n), slotsValid: z.bigint().min(1n) }).strict(),
  z.object({ domain: z.literal('solana_durable_nonce'), nonceValue: z.string().max(88), singleUse: z.literal(true) }).strict(),
  /**
   * An EVM transaction expires by *sequence*, not by clock: it stays signable until an earlier
   * nonce supersedes it, and EIP-155 puts the chain id inside the signing payload so the bytes are
   * not valid on a second network. `chainBound` is therefore `literal(true)` — a legacy envelope
   * whose `v` does not encode a chain id is not this domain at all, it is `preEip155Replayable`,
   * and `@ari/chain-evm` refuses it rather than calling it unbounded.
   */
  z.object({ domain: z.literal('evm_nonce'), nonce: z.bigint().min(0n), chainBound: z.literal(true) }).strict(),
]);
export type Expiry = z.infer<typeof Expiry>;

export const ValidatedTransaction = z
  .object({
    supported: z.literal(true),
    chain: ChainFamily,
    network: NetworkId,
    /**
     * The identifier the chain itself will use for this transaction, **where one exists yet**.
     *
     * `null` is not a gap to be filled in later by whoever remembers: on EVM the transaction hash is
     * `keccak256` over the *signed* envelope, so it is undefined until a signature exists, and putting
     * the signing hash in this slot would hand reconciliation a receipt lookup key that resolves to
     * nothing forever. That is why the field is optional rather than defaulted — and why the ticket
     * binds `signingDigest` plus `bytesSha256`, which are both fully determined before anybody signs.
     * Sui and Solana differ: Sui's `TransactionDigest` is over the unsigned `TransactionData`, so a
     * constructed Sui transaction has an identifier the moment it is built.
     */
    txDigest: ChainTransactionDigest.nullable(),
    /** The digest over the exact bytes a signature will cover. This is the one the signer checks. */
    signingDigest: ChainTransactionDigest,
    /** sha256 of the serialized bytes, hex — so the canonical digest binds bytes without embedding them. */
    bytesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.bigint().min(1n),
    signer: z.string().min(1).max(256),
    effects: z.array(Effect).min(1, 'a validated transaction with no effects is not a validated transaction'),
    authorities: z.array(AuthorityExercise),
    stateDependencies: z.array(StateDependency),
    expiry: Expiry,
    /** The decoder that produced this, and the capability set it claimed while doing so. */
    producedBy: z.object({ adapter: z.string().min(1).max(64), decoderVersion: z.string().min(1).max(32) }).strict(),
  })
  .strict();
export type ValidatedTransaction = z.infer<typeof ValidatedTransaction>;

export type DecodeResult = ValidatedTransaction | Unsupported;

export function isSupported(result: DecodeResult): result is ValidatedTransaction {
  return result.supported === true;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What an adapter can honestly do, declared rather than inferred from the fact that it exists.
 * Every one of these is a sentence the policy language is allowed to depend on; a policy that
 * requires a capability the loaded adapter does not have must be refused at startup, not at
 * request time, because the request-time answer would be a silent permissive default.
 */
export const AdapterCapabilities = z.object({
  /** Parses a serialized transaction into `ValidatedTransaction` without a network call. */
  decodesOffline: z.boolean(),
  /** Resolves every account/object the bytes refer to (lookup tables, wrapped objects). */
  resolvesReferences: z.boolean(),
  /** Establishes the asset identity, not just the object or account holding it. */
  identifiesAssets: z.boolean(),
  /** Reports authority exercises (capabilities, delegates), or leaves them invisible. */
  resolvesAuthorityEffects: z.boolean(),
  /** Can bind the transaction to one network, or accepts whatever the bytes claim. */
  bindsNetwork: z.boolean(),
  /** Can produce the digest the signature will cover, independently of the decision plane. */
  computesSigningDigest: z.boolean(),
  /** Can ask the chain what would happen (dry run / simulate), and bind the answer. */
  canSimulate: z.boolean(),
  /** Can check the transaction after submission for real, not from an RPC's success flag. */
  canVerifySettlement: z.boolean(),
}).strict();
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>;

/** A capability a policy needs. `decodesOffline` and `computesSigningDigest` are never optional. */
export const RequiredCapability = AdapterCapabilities.keyof();
export type RequiredCapability = z.infer<typeof RequiredCapability>;

export const NON_NEGOTIABLE: readonly RequiredCapability[] = ['decodesOffline', 'computesSigningDigest'] as const;

export interface CapabilityGap {
  readonly missing: readonly RequiredCapability[];
  readonly detail: string;
}

/**
 * Refuse an adapter that cannot carry the policy's claims. Note that this returns the gap rather
 * than throwing: the caller has to say which adapter, on which chain, in which startup log.
 */
export function checkCapabilities(
  declared: AdapterCapabilities,
  required: readonly RequiredCapability[],
): CapabilityGap | null {
  const missing = [...new Set([...NON_NEGOTIABLE, ...required])].filter((key) => declared[key] === false);
  if (missing.length === 0) return null;
  return {
    missing,
    detail: `adapter declares ${missing.join(', ')} as unsupported; a policy that relies on `
      + `those would be enforced by a component that cannot perform them`,
  };
}

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

/**
 * Chain state the decoder is allowed to be handed. Adapters take it as an argument rather than
 * fetching it: a decoder that reaches the network inside a decision path makes the policy engine
 * dependent on a resource it cannot pin, version, or replay, and `@ari/policy-engine`'s purity is
 * the property the audit trail rests on.
 */
export interface StateEvidence {
  /** Absolute addresses resolved from lookup tables, or object/type data for Sui. */
  readonly entries: ReadonlyArray<{ id: string; contentBase64: string; contentHash: string; readAtSlotOrEpoch: bigint }>;
  readonly readBy: string;
}

export interface ChainAdapter {
  readonly chain: 'evm' | 'sui' | 'solana';
  readonly name: string;
  readonly decoderVersion: string;
  readonly capabilities: AdapterCapabilities;
  /** The one entry point. It never throws a permissive value: `Unsupported` is the answer. */
  decode(serializedBytes: Uint8Array, network: NetworkId, evidence: StateEvidence): DecodeResult;
  /** Re-derives the signing digest from bytes, for the signer to check independently. */
  signingDigestOf(serializedBytes: Uint8Array): ChainTransactionDigest | null;
  /** The largest transaction this adapter will accept, so a giant payload is a refusal not an event. */
  readonly maxBytes: number;
}
