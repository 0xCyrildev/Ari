/**
 * Policy authoring schema.
 *
 * This is the shape a human or an AI proposal writes. It is *not* what the
 * engine evaluates — `compilePolicy()` in @ari/policy-engine turns it into an
 * immutable normalised form once, at activation, and evaluation never reads
 * this shape again (ASSUMPTIONS A4). The reason is determinism plus
 * replayability: a decision made in March must be re-derivable from bytes in
 * September, which requires that evaluation have no I/O and no clock.
 *
 * The schema's most important property is what it cannot express. There is no
 * wildcard recipient, no `unrestricted` asset list, no omit-and-therefore-open
 * limit. Default deny (S1) is not a behaviour of the engine, it is an absence in
 * this vocabulary: `recipients.mode` has exactly one legal value, and it is not
 * a choice. An option present in a schema is an option someone will eventually
 * select, so the unsafe ones are not deprecated, they are absent.
 */

import { z } from 'zod';
import { AssetRef, BitcoinAddress, EvmAddress, SignatureTriple, SupportedChain } from './primitives.js';

/** A limit that names its unit. `5000` next to `2000000000` is an accident. */
const Limit = z
  .object({
    maxRaw: z.string().regex(/^\d+$/, 'maxRaw must be an integer string in raw units'),
    unit: z.string().min(1).max(32),
  })
  .strict();

const RecipientAllowlist = z
  .object({
    mode: z.literal('allowlist'),
    // One grammar per chain that can be paid: the comparison the kernel makes is an
    // exact string match against `candidate.recipient.address`, so an entry that is not
    // a valid address of either kind compares unequal forever — a policy that looked
    // restrictive was a permanent deny with a friendly editor.
    //
    // The message is written out because a union discards its branches' own reasons: an
    // entry that is merely checksummed was refusing with the words "Invalid input", which
    // tells an author that something is wrong and not what to type instead. That is the
    // whole difference between a parse error and a dead end.
    addresses: z
      .array(
        z.union([EvmAddress, BitcoinAddress], {
          error: 'expected a lowercase 0x + 40 hex EVM address, or a bitcoin address',
        }),
      )
      .min(1, 'an allowlist with no entries is a deny'),
  })
  .strict();

const EscalationCondition = z.discriminatedUnion('op', [
  z.object({ op: z.literal('amount_gt'), raw: z.string().regex(/^\d+$/), unit: z.string() }).strict(),
  z.object({ op: z.literal('recipient_not_in_allowlist') }).strict(),
  z.object({ op: z.literal('recipient_first_seen_within_days'), days: z.number().int().min(0).max(3650) }).strict(),
  z.object({ op: z.literal('asset_not_in_baseline') }).strict(),
  z.object({ op: z.literal('chain_not_in_baseline') }).strict(),
  z.object({ op: z.literal('risk_gte'), level: z.enum(['MEDIUM', 'HIGH', 'CRITICAL']) }).strict(),
  z.object({ op: z.literal('usd_gte'), cents: z.string().regex(/^\d+$/) }).strict(),
  z.object({ op: z.literal('time_out_of_hours_window'), window: z.string().min(1).max(64) }).strict(),
  z.object({ op: z.literal('velocity_gt_per_hour'), count: z.number().int().min(0) }).strict(),
]);

export const WalletAuthorityMode = z.enum([
  /**
   * `delegated` — a `shared` dWallet. The signer holds everything needed to
   * sign; a human approval is an application-layer control enforced by Ari's
   * database. If Ari is fully compromised, this mode offers no cryptographic
   * protection, and no screen may imply otherwise.
   *
   * Choosing it is **irreversible** on the Ika side: converting a zero-trust
   * dWallet to shared publishes the user share permanently and replaces the
   * 2PC non-collusion guarantee with trust in a network threshold
   * (ASSUMPTIONS I16, I17, §4.7a).
   */
  'delegated',
  /**
   * `user_gated` — a `zero-trust` dWallet. Completing a signing ceremony
   * requires the user's secret share, decryptable only with keys the human's
   * device holds (ASSUMPTIONS I4). A forged approval, a compromised `ari-api`
   * and a stolen database do not add up to a signature.
   */
  'user_gated',
]);
export type WalletAuthorityMode = z.infer<typeof WalletAuthorityMode>;

export const PolicyDocument = z
  .object({
    meta: z
      .object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000).nullable(),
      })
      .strict(),

    /** Which wallet this policy governs, and how much the wallet's mode can promise. */
    target: z
      .object({
        walletId: z.string(),
        authorityMode: WalletAuthorityMode,
        signatureTriple: SignatureTriple,
      })
      .strict(),

    permissions: z
      .object({
        transfers: z
          .object({
            enabled: z.boolean(),
            chains: z.array(SupportedChain).max(10),
            assets: z.array(AssetRef).max(200),
            recipients: RecipientAllowlist,
            perTransaction: Limit,
            perDay: Limit,
            perMonth: Limit.nullable(),
            maxTransactionsPerHour: z.number().int().min(0).max(10000),
          })
          .strict(),

        contractCalls: z
          .object({
            enabled: z.boolean(),
            contracts: z.array(EvmAddress).max(200),
          })
          .strict(),

        /**
         * Novelty as a first-class permission rather than a nice-to-have.
         * T1's patient adversary stays inside every numeric limit; the control
         * that actually catches it is "this recipient has never been paid".
         */
        newRecipients: z
          .object({
            allowed: z.boolean(),
            requireApproval: z.boolean(),
          })
          .strict(),
      })
      .strict(),

    escalation: z
      .object({
        humanApproval: z
          .object({
            /** Empty array is legal and means "never escalate" — so it is loud, not implied. */
            requiredWhen: z.array(EscalationCondition).max(50),
            approverRoles: z.array(z.enum(['owner', 'admin', 'approver'])).min(1),
            /**
             * Quorum is enforced by Ari's database in the MVP. Ika offers an
             * on-chain t-of-N pattern (`ikavery`) that Ari does not yet use, so
             * nothing may claim chain-enforced multi-party approval while this
             * is `application` (ASSUMPTIONS §4.7b, invariant S12).
             */
            quorumEnforcement: z.literal('application'),
            quorum: z.number().int().min(1).max(10),
          })
          .strict(),
      })
      .strict(),

    validity: z
      .object({
        transactionTtlSeconds: z.number().int().min(30).max(86400),
        notBefore: z.iso.datetime().nullable(),
        notAfter: z.iso.datetime().nullable(),
        /**
         * Deny-before-cost (ASSUMPTIONS §4.3): every Ika operation spends real
         * IKA and SUI, so a policy bug is a money bug even when it never signs
         * anything, and a hostile agent can be expensive while being denied.
         */
        signingBudget: z
          .object({
            maxIkaRawPerDay: z.string().regex(/^\d+$/),
            alertAtIkaRawPerDay: z.string().regex(/^\d+$/),
          })
          .strict(),
      })
      .strict(),

    /**
     * Mandatory, not defaulted. A policy that does not state what happens when
     * the risk engine is unreachable is a policy that improvises at the worst
     * possible moment (S15).
     */
    fallback: z
      .object({
        onUnknownTransaction: z.literal('deny'),
        onEvaluationError: z.literal('deny'),
        onRiskUnavailable: z.enum(['deny', 'escalate']),
        onSimulationUnavailable: z.enum(['allow_advisory', 'deny']),
      })
      .strict(),

    limits: z
      .object({
        /** Ceiling the FX source may be stale by before a usd_* condition refuses. */
        maxUsdEstimateAgeSeconds: z.number().int().min(1).max(86400),
        maxDeadlineSkewSeconds: z.number().int().min(0).max(3600),
      })
      .strict(),
  })
  .strict();

export type PolicyDocument = z.infer<typeof PolicyDocument>;
export type EscalationCondition = z.infer<typeof EscalationCondition>;

export const PolicyVersionNumber = z.number().int().min(1);

/** What `POST /v1/policies` accepts, before it has an identity or a version. */
export const PolicyDraftInput = PolicyDocument;
