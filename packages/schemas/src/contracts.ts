/**
 * Decision, risk, intent and ticket contracts.
 *
 * These types are where "the LLM is not the security boundary" stops being a
 * sentence and becomes a compiler error. Three properties, each doing real
 * work:
 *
 *   - `Decision` is a **total** three-variant union with no fourth "unknown"
 *     and no optional decision. `evaluate()` cannot return nothing, so a caller
 *     cannot branch into "well, it didn't say no" (S15, A11).
 *   - `RiskAssessment` has no path to a decision value. Risk can escalate and
 *     annotate; it structurally cannot grant (A6).
 *   - `AuthorizationTicket` is branded and opaque. It is minted in exactly one
 *     module and `SigningProvider` accepts nothing else, which is what makes
 *     "authorize before signing" a type-level fact rather than a convention (S4).
 */

import { z } from 'zod';
import { AgentId, Money, PolicyVersionId, RawBigIntNonNeg, RequestId, TransactionRequestId, WalletId } from './primitives.js';
import { CanonicalDigest, CandidateTransaction } from './transaction.js';
import { WalletAuthorityMode } from './policy.js';

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Reason codes are a closed vocabulary. They are the difference between an
 * authorization system and a `403`: an agent that cannot tell its operator
 * *which* rule refused will work around the refusal, and a support engineer
 * without a code has no unit of work to investigate.
 */
export const ReasonCode = z.enum([
  // identity & credential
  'AGENT_NOT_FOUND',
  'AGENT_REVOKED',
  'AGENT_PAUSED',
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_REVOKED',
  'SCOPE_MISSING',
  'ORGANIZATION_MISMATCH',
  // structure & support
  'TRANSACTION_UNKNOWN',
  'CHAIN_NOT_SUPPORTED',
  'CHAIN_PRE_ALPHA',
  'ASSET_NOT_ALLOWED',
  'CONTRACTS_NOT_ALLOWED',
  'CONTRACT_NOT_ALLOWED',
  'TRANSFER_TYPE_DISABLED',
  // limits
  'AMOUNT_ZERO',
  'AMOUNT_EXCEEDS_PER_TRANSACTION',
  'AMOUNT_EXCEEDS_DAILY_LIMIT',
  'AMOUNT_EXCEEDS_MONTHLY_LIMIT',
  'VELOCITY_EXCEEDS_HOURLY_LIMIT',
  'LIMIT_RESERVATION_FAILED',
  'SIGNING_BUDGET_EXCEEDED',
  // recipients & novelty
  'RECIPIENT_NOT_ALLOWED',
  'RECIPIENT_NOT_IN_ALLOWLIST',
  'NEW_RECIPIENT_NOT_ALLOWED',
  'ASSET_NOVEL',
  'CHAIN_NOVEL',
  // time
  'DEADLINE_EXPIRED',
  'POLICY_NOT_YET_VALID',
  'POLICY_EXPIRED',
  'OUT_OF_HOURS_WINDOW',
  // approval
  'HUMAN_APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_CONSUMED',
  'APPROVAL_DIGEST_MISMATCH',
  'APPROVAL_NOT_FOUND',
  'APPROVER_NOT_AUTHORISED',
  'QUORUM_NOT_REACHED',
  'JUSTIFICATION_REQUIRED',
  // risk & simulation
  'RISK_ESCALATION_REQUIRED',
  'RISK_ENGINE_UNAVAILABLE',
  'SIMULATION_FAILED',
  'SIMULATION_MISMATCH',
  'SIMULATION_UNAVAILABLE',
  // signing
  'TICKET_INVALID',
  'TICKET_EXPIRED',
  'TICKET_ALREADY_USED',
  'TICKET_DIGEST_MISMATCH',
  'SIGNER_KEY_MISMATCH',
  'SIGNING_PROVIDER_ERROR',
  // fail-closed
  'INTERNAL_ERROR_FAIL_CLOSED',
  'FX_STALE',
  'IDEMPOTENCY_CONFLICT',
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const MatchedRule = z
  .object({
    /** Dot path into the compiled policy, e.g. `permissions.transfers.perTransaction`. */
    rulePath: z.string().min(1).max(200),
    outcome: z.enum(['allow', 'deny', 'escalate']),
    detail: z.string().max(500).nullable(),
  })
  .strict();
export type MatchedRule = z.infer<typeof MatchedRule>;

const decisionBase = {
  requestId: RequestId,
  policyId: z.string(),
  policyVersionId: PolicyVersionId,
  /** Epoch seconds, supplied to evaluation rather than read from a clock (A4). */
  evaluatedAtMs: RawBigIntNonNeg,
  matchedRules: z.array(MatchedRule).max(100),
  riskLevel: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable(),
};

export const Decision = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('ALLOW'),
      reasonCodes: z.array(ReasonCode).max(20),
      /** The exact bytes this ALLOW authorises — a ticket seals this and nothing else. */
      digest: CanonicalDigest,
      authorityMode: WalletAuthorityMode,
      ...decisionBase,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('DENY'),
      /** A DENY with no reason codes is a support ticket, not a decision. */
      reasonCodes: z.array(ReasonCode).min(1).max(20),
      /**
       * No digest, deliberately: a candidate the canonicaliser refuses still has
       * to be deniable, and requiring the digest here would make an
       * unencodable transaction produce no decision at all rather than a DENY.
       */
      ...decisionBase,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('REQUIRE_HUMAN_APPROVAL'),
      reasonCodes: z.array(ReasonCode).min(1).max(20),
      /** The digest the human will be shown, which is also what they sign over. */
      digest: CanonicalDigest,
      expiresAt: z.iso.datetime(),
      ...decisionBase,
    })
    .strict(),
]);
export type Decision = z.infer<typeof Decision>;
export type DecisionOutcome = Decision['outcome'];

// ---------------------------------------------------------------------------
// Risk — advisory, and unable to say otherwise
// ---------------------------------------------------------------------------

export const RiskSignal = z.enum([
  'NEW_RECIPIENT',
  'RECIPIENT_VELOCITY_CHANGE',
  'AMOUNT_ABOVE_BASELINE',
  'AMOUNT_8X_BASELINE',
  'NEW_ASSET',
  'NEW_CHAIN',
  'NEW_CONTRACT',
  'OUT_OF_HOURS',
  'UNUSUAL_APPROVAL_PATTERN',
  'POLICY_BOUNDARY_PROXIMITY',
  'BEHAVIOUR_PROFILE_DRIFT',
  'DORMANT_AGENT_RESUMED',
  'SIMULATION_WARNING',
  'MODEL_OUTPUT_INCONSISTENCY',
]);

export const RiskAssessment = z
  .object({
    requestId: RequestId,
    /** Deterministic statistics in the MVP; `model_version` is a featureset id, not a claim of ML. */
    score: z.number().min(0).max(1),
    level: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    signals: z.array(RiskSignal).max(50),
    explanation: z.string().max(4000),
    baselineWindowDays: z.number().int().min(1),
    modelVersion: z.string().min(1).max(80),
    computedAtMs: RawBigIntNonNeg,
  })
  .strict();
export type RiskAssessment = z.infer<typeof RiskAssessment>;

// ---------------------------------------------------------------------------
// Intent — the model's entire vocabulary
// ---------------------------------------------------------------------------

/** Where a value came from. Provenance is displayed at approval time (T3). */
export const FieldProvenance = z.enum(['user', 'agent', 'document', 'tool', 'model', 'resolved']);
export type FieldProvenance = z.infer<typeof FieldProvenance>;

const provenanced = <T extends z.ZodType>(schema: T) =>
  z
    .object({ value: schema, provenance: FieldProvenance })
    .strict();

export const IntentInput = z
  .object({
    utterance: z.string().min(1).max(8000),
    /** Untrusted context is passed separately and never concatenated into instructions (T3). */
    attachments: z
      .array(z.object({ kind: z.string().max(40), content: z.string().max(20000) }).strict())
      .max(20),
  })
  .strict();

/**
 * Parsed model output. `VALID` still authorises nothing: the policy engine acts
 * on a `CandidateTransaction`, and an `Intent` becomes one only through the
 * transaction builder plus deterministic resolution (T3 mitigation [S]).
 */
export const IntentInterpretation = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('VALID'),
      action: z.enum(['transfer', 'contract_call']),
      amount: provenanced(Money).nullable(),
      asset: z.string().max(32).nullable(),
      chain: z.string().max(64).nullable(),
      /** A resolved address, with the resolution recorded rather than trusted. */
      recipient: provenanced(z.string().min(1).max(200)).nullable(),
      recipientHandle: z.string().max(200).nullable(),
      contract: z.string().max(200).nullable(),
      purpose: z.string().max(500).nullable(),
      model: z.string().min(1).max(120),
      confidence: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('NEEDS_CLARIFICATION'),
      /**
       * The anti-hallucination mechanism, not a polite message. "Pay John"
       * produces an open question here and no candidate transaction anywhere
       * (T5). Making this a distinct terminal state means no code path can
       * "helpfully" proceed with a guessed recipient.
       */
      missing: z.array(z.string().max(120)).min(1).max(20),
      suggestions: z.array(z.string().max(200)).max(20),
      model: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      status: z.literal('INVALID'),
      reason: z.string().min(1).max(500),
      model: z.string().min(1).max(120),
    })
    .strict(),
]);
export type IntentInterpretation = z.infer<typeof IntentInterpretation>;

// ---------------------------------------------------------------------------
// Authorization ticket — the only thing the signer accepts
// ---------------------------------------------------------------------------

export const TicketClaims = z
  .object({
    ticketId: z.string().min(1).max(64),
    /**
     * The transaction *request* this ticket authorises, not a correlation id.
     *
     * Corrected when the pipeline first minted a real ticket: the two ids look
     * alike, are generated by different code, and only one of them is the row a
     * decision and a reservation point back at. A ticket sealed against the wrong
     * one is a ticket nothing can reconcile.
     */
    requestId: TransactionRequestId,
    agentId: AgentId,
    walletId: WalletId,
    policyVersionId: PolicyVersionId,
    digest: CanonicalDigest,
    /** Raw amount carried in the claim so the signer can double-check the digest it is about to sign. */
    amountRaw: RawBigIntNonNeg,
    issuedAtMs: RawBigIntNonNeg,
    expiresAtMs: RawBigIntNonNeg,
    /** Single-use nonce; a second redemption of the same ticket is a hard error (T9, T12). */
    nonce: z.string().min(16).max(64),
    authorityMode: WalletAuthorityMode,
  })
  .strict();
export type TicketClaims = z.infer<typeof TicketClaims>;

/**
 * Opaque, sealed ticket as it crosses the plane boundary: the serialised claims
 * plus an HMAC the authority plane verifies with a key the decision plane does
 * not hold (ASSUMPTIONS A2, THREAT_MODEL T18).
 *
 * The brand is the point. Any attempt to construct one from a plain string
 * outside `@ari/signing` fails to compile, so "we skipped authorization" cannot
 * be written by accident.
 */
export const AuthorizationTicket = z.string().min(40).brand('AuthorizationTicket');
export type AuthorizationTicket = z.infer<typeof AuthorizationTicket>;

/**
 * A bound approval token, presented by a human's client when they decide.
 *
 * Branded for the same reason as `AuthorizationTicket` and with the opposite
 * direction of trust: a ticket is minted by the decision plane and spent by the
 * signer, whereas a token is minted by Ari, *shown to a human*, and spent back at
 * Ari. It is therefore a bearer secret with a short life, which is why the
 * approval's own record stores the digest it committed to and never the token
 * (§8, §11's redaction rule).
 */
export const ApprovalToken = z.string().min(40).brand('ApprovalToken');
export type ApprovalToken = z.infer<typeof ApprovalToken>;

/** What a caller must present to the SDK's money-moving method. Nothing else is accepted. */
export const AgentTransactionRequest = z
  .object({
    intent: z.string().min(1).max(8000),
    candidate: CandidateTransaction,
  })
  .strict();
