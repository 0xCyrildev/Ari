/**
 * The candidate transaction: the single normalised representation that policy,
 * risk, simulation, approval and signing all operate on.
 *
 * The canonical digest is the load-bearing object here. It is computed once at
 * VALIDATED and re-derived-and-compared at approval redemption, at ticket
 * minting and at signing — three independent comparisons of the same bytes.
 * Every substitution threat in THREAT_MODEL.md (T10, T11, T12) is a way of
 * getting a transaction signed that is not the one a human looked at, and the
 * answer to all of them is this file rather than a review comment.
 */

import { z } from 'zod';
import {
  AgentId,
  AssetRef,
  EvmAddress,
  Money,
  RawBigIntNonNeg,
  RecipientAddress,
  RequestId,
  SupportedChain,
  UsdEstimate,
  WalletId,
} from './primitives.js';

/**
 * Chain-family-tagged replay protection.
 *
 * A flat `nonce` field would be a lie for half the supported targets — Bitcoin
 * has no nonce, and account chains need per-sender sequences with replacement
 * rules (ASSUMPTIONS §5.5). Modelling it as a union makes "which scheme applies
 * to this chain" a type error when it is wrong.
 */
export const ReplayProtection = z.discriminatedUnion('scheme', [
  z
    .object({
      scheme: z.literal('account_sequence'),
      /** Assigned by Ari, serialised per (wallet, chain, sender). Never by the caller. */
      nonce: RawBigIntNonNeg,
      chainId: z.string().min(1).max(32),
      /**
       * Required, not nullable — and digested, because `replayProtection` is in
       * `DIGEST_FIELD_ALLOWLIST` as a whole object.
       *
       * Ari now *builds* the bytes a signature covers, and an EIP-1559 payload has no slot for an
       * absent fee cap. A nullable field was harmless while the pipeline hashed only a semantic
       * description of intent; the moment a ticket seals `keccak256(0x02 ‖ rlp(…))`, a `null` here
       * means somebody chose a number the human approving the payment never saw. So there is no
       * `null` to reach: these three values are the envelope's three values, and `@ari/chain-evm`
       * refuses any of them above the deployment's bounds instead of defaulting one.
       *
       * `maxPriorityFeePerUnit` is the tip cap, and separate because EIP-1559 charges
       * `min(maxFeePerGas, maxPriorityFeePerGas + baseFee)` — folding it into the fee cap would
       * silently rewrite what the wallet can actually pay.
       */
      gasLimit: RawBigIntNonNeg,
      maxFeePerUnit: RawBigIntNonNeg,
      maxPriorityFeePerUnit: RawBigIntNonNeg,
    })
    .strict(),
  z
    .object({
      scheme: z.literal('utxo'),
      inputs: z.array(z.string().min(1).max(200)).min(1),
      outputs: z.array(z.string().min(1).max(200)).min(1),
    })
    .strict(),
  z
    .object({
      scheme: z.literal('message_digest'),
      digest: z.string().min(1).max(200),
    })
    .strict(),
]);
export type ReplayProtection = z.infer<typeof ReplayProtection>;

const commonFields = {
  requestId: RequestId,
  agentId: AgentId,
  walletId: WalletId,
  /** Wall-clock ceiling carried into the ticket; enforced again at signing. */
  deadline: z.iso.datetime(),
  /** Idempotency key: a retry returns the same decision, never a second reservation. */
  idempotencyKey: z.string().min(1).max(200),
  usdEstimate: UsdEstimate.nullable(),
};

export const TransferTransaction = z
  .object({
    kind: z.literal('transfer'),
    chain: SupportedChain,
    asset: AssetRef,
    amount: Money,
    recipient: RecipientAddress,
    replayProtection: ReplayProtection,
    ...commonFields,
  })
  .strict();

export const ContractCallTransaction = z
  .object({
    kind: z.literal('contract_call'),
    chain: z.literal('ethereum'),
    // An EVM address, not "42 characters": the recipient grammar already says so, and
    // the comparison the kernel makes is an exact string match against the policy's
    // allowlist. A 42-character string that is not an address can only ever fail that
    // match, so the shape that gets through the parser is the shape that silently
    // disables the rule.
    contract: EvmAddress,
    selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/, 'expected a 4-byte function selector'),
    calldata: z.string().regex(/^0x[0-9a-fA-F]*$/, 'expected hex calldata').max(131_072, 'calldata over 64 KiB is not a transaction, it is an upload'),
    value: RawBigIntNonNeg,
    replayProtection: ReplayProtection,
    ...commonFields,
  })
  .strict();

/**
 * The parser's failure mode, as a value.
 *
 * Principle 15/16 say unknown transaction types are denied. If "unknown" were
 * an exception, every caller would have to remember to handle it and one of
 * them would eventually decide a caught exception looks like a soft warning. As
 * a kind, the policy engine has an exhaustive rule for it and fail-closed is the
 * ordinary path rather than the careful one (ASSUMPTIONS A11, invariant S2).
 */
export const UnknownTransaction = z
  .object({
    kind: z.literal('unknown'),
    reason: z.string().min(1).max(500),
    /** Chain is deliberately `string` here: an unknown chain is exactly what this is for. */
    reportedChain: z.string().min(1).max(64),
    ...commonFields,
  })
  .strict();

export const CandidateTransaction = z.discriminatedUnion('kind', [
  TransferTransaction,
  ContractCallTransaction,
  UnknownTransaction,
]);
export type CandidateTransaction = z.infer<typeof CandidateTransaction>;
export type TransferTx = z.infer<typeof TransferTransaction>;
export type ContractCallTx = z.infer<typeof ContractCallTransaction>;
export type UnknownTx = z.infer<typeof UnknownTransaction>;

/**
 * Opaque branded digest. There is one constructor — `canonicalize()` in
 * @ari/transaction-engine — and producing one any other way is a type error.
 * A caller-computed digest would be a caller-chosen digest.
 */
export const CanonicalDigest = z
  .string()
  .regex(/^canon\/v1:[0-9a-f]{64}$/)
  .brand('CanonicalDigest');
export type CanonicalDigest = z.infer<typeof CanonicalDigest>;

/**
 * The fields that participate in the canonical digest, declared **once**, here,
 * because `@ari/transaction-engine` consumes this list. Two copies of a digest
 * allowlist is the T10 substitution bug in waiting: the day they disagree, the
 * transaction a human approved and the transaction that got signed are allowed
 * to differ by exactly the field one copy forgot.
 */
export const DIGEST_FIELD_ALLOWLIST = [
  'kind',
  'chain',
  'reportedChain',
  'asset',
  'amount',
  'recipient',
  'contract',
  'selector',
  'calldata',
  'value',
  'replayProtection',
  'deadline',
  'walletId',
  'agentId',
  'reason',
] as const;

/**
 * Every remaining top-level field of every candidate variant, named so the
 * omission is a decision rather than an accident. A test asserts that
 * allowlist ∪ this list is exactly the set of keys the candidate schemas can
 * produce, which is what fails when someone adds a field without deciding
 * whether it is substitution-critical.
 */
export const DELIBERATELY_NOT_IN_DIGEST = ['requestId', 'idempotencyKey', 'usdEstimate'] as const;

/** Recipient/amount/chain/asset are the subset a decision has already bound. */
export const IMMUTABLE_AFTER_DECISION = ['recipient', 'amount', 'chain', 'asset'] as const;

export function isSubstitutionCritical(field: string): boolean {
  return (IMMUTABLE_AFTER_DECISION as readonly string[]).includes(field);
}
