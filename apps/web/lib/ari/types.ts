/**
 * The frontend's view of the Ari contract.
 *
 * Every union below is copied from a named file in this repository, not invented for the
 * screen. That matters more than usual in a UI: a dashboard that displays a status the
 * engine cannot produce teaches its users a false model of their own controls, and the
 * prompt for this application said plainly: do not fabricate. Where the real type lives:
 *
 *   ReasonCode ................. packages/schemas/src/contracts.ts:33
 *   RiskSignal ................... packages/schemas/src/contracts.ts:164
 *   RiskAssessment ............... packages/schemas/src/contracts.ts:183
 *   LifecycleState ............... packages/transaction-engine/src/index.ts:132
 *   Audit event types ............ packages/audit/src/index.ts:45
 *   PolicyDocument ............... packages/schemas/src/policy.ts:79
 *   Wallet authority mode ........ packages/schemas/src/policy.ts:56
 *   Scopes ....................... packages/identity/src/tenant.ts (SCOPES)
 *   Candidate variants ........... packages/schemas/src/transaction.ts:73
 *
 * The HTTP layer that will replace `api/mock.ts` is `apps/api/src/routes.ts`; the field
 * names here match what those routes answer with, so the swap is a client change and not a
 * redesign. Amounts are decimal strings throughout, because that is the wire rule
 * (`numeric(80,0)`), and a JavaScript number cannot hold 10^30 wei without rounding.
 */

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type DecisionOutcome = 'ALLOW' | 'REQUIRE_HUMAN_APPROVAL' | 'DENY';

/** A subset of the real `ReasonCode` enum; see the header for the source. */
export type ReasonCode =
  | 'AGENT_REVOKED'
  | 'AGENT_PAUSED'
  | 'SCOPE_MISSING'
  | 'ASSET_NOT_ALLOWED'
  | 'CHAIN_NOT_SUPPORTED'
  | 'CONTRACT_NOT_ALLOWED'
  | 'CONTRACTS_NOT_ALLOWED'
  | 'CONTRACT_VALUE_NOT_PERMITTED'
  | 'AMOUNT_ZERO'
  | 'AMOUNT_EXCEEDS_PER_TRANSACTION'
  | 'AMOUNT_EXCEEDS_DAILY_LIMIT'
  | 'AMOUNT_EXCEEDS_MONTHLY_LIMIT'
  | 'VELOCITY_EXCEEDS_HOURLY_LIMIT'
  | 'LIMIT_RESERVATION_FAILED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'RECIPIENT_NOT_IN_ALLOWLIST'
  | 'NEW_RECIPIENT_NOT_ALLOWED'
  | 'ASSET_NOVEL'
  | 'CHAIN_NOVEL'
  | 'DEADLINE_EXPIRED'
  | 'POLICY_NOT_YET_VALID'
  | 'POLICY_EXPIRED'
  | 'OUT_OF_HOURS_WINDOW'
  | 'HUMAN_APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'APPROVAL_DIGEST_MISMATCH'
  | 'APPROVER_NOT_AUTHORISED'
  | 'QUORUM_NOT_REACHED'
  | 'JUSTIFICATION_REQUIRED'
  | 'RISK_ESCALATION_REQUIRED'
  | 'RISK_ENGINE_UNAVAILABLE'
  | 'SIMULATION_FAILED'
  | 'SIMULATION_MISMATCH'
  | 'SIMULATION_UNAVAILABLE'
  | 'TICKET_INVALID'
  | 'TICKET_EXPIRED'
  | 'TICKET_ALREADY_USED'
  | 'TICKET_DIGEST_MISMATCH'
  | 'SIGNER_KEY_MISMATCH'
  | 'SIGNING_PROVIDER_ERROR'
  | 'SIGNING_BUDGET_EXCEEDED'
  | 'FX_STALE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL_ERROR_FAIL_CLOSED';

export type RiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type RiskSignalName =
  | 'NEW_RECIPIENT'
  | 'RECIPIENT_VELOCITY_CHANGE'
  | 'AMOUNT_ABOVE_BASELINE'
  | 'AMOUNT_8X_BASELINE'
  | 'NEW_ASSET'
  | 'NEW_CHAIN'
  | 'NEW_CONTRACT'
  | 'OUT_OF_HOURS'
  | 'UNUSUAL_APPROVAL_PATTERN'
  | 'POLICY_BOUNDARY_PROXIMITY'
  | 'BEHAVIOUR_PROFILE_DRIFT'
  | 'DORMANT_AGENT_RESUMED'
  | 'NO_BEHAVIOUR_BASELINE'
  | 'SIMULATION_WARNING'
  | 'MODEL_OUTPUT_INCONSISTENCY';

export interface RiskAssessment {
  readonly score: number;
  readonly level: RiskLevel;
  readonly signals: readonly RiskSignalName[];
  readonly baselineWindowDays: number;
  readonly modelVersion: string;
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Lifecycle, exactly as `transaction-engine` defines it
// ---------------------------------------------------------------------------

export type LifecycleState =
  | 'DRAFT'
  | 'VALIDATED'
  | 'EVALUATING'
  | 'DENIED'
  | 'APPROVAL_PENDING'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'RESERVED'
  | 'TICKET_MINTED'
  | 'SIGNING_PENDING'
  | 'SIGNING_COMPLETE'
  | 'SIGNING_FAILED'
  | 'SIGNING_TIMEOUT'
  | 'BROADCAST'
  | 'BROADCAST_CONFIRMED'
  | 'ABANDONED';

/**
 * Where the product is honest about its own edge. Today the lifecycle stops at
 * `TICKET_MINTED`/`SIGNING_COMPLETE`: settlement belongs to a provider-confirmed callback
 * or a reconciliation pass, neither of which exists, and a mock's `COMPLETE` is not a chain
 * fact. The UI says so rather than showing a tick it has not earned.
 */
export const EXECUTION_UNSETTLED: readonly LifecycleState[] = ['SIGNING_COMPLETE', 'TICKET_MINTED'];

// ---------------------------------------------------------------------------
// Agents, wallets, policies
// ---------------------------------------------------------------------------

export type AgentStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED';

/** `ANOMALOUS` and `AWAITING_APPROVAL` are UI-derived, not stored: see `deriveAgentState`. */
export type AgentSurfaceState = AgentStatus | 'AWAITING_APPROVAL' | 'ANOMALOUS';

export type Scope =
  | 'transaction:request'
  | 'approval:decide'
  | 'agent:manage'
  | 'wallet:manage'
  | 'policy:activate'
  | 'audit:read'
  | 'transaction:read';

export interface Credential {
  readonly id: string;
  readonly prefix: 'crd_' | 'ucrd_';
  readonly scopes: readonly Scope[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

/** `delegated` = a shared dWallet; `user_gated` needs the human's device to sign. */
export type WalletMode = 'delegated' | 'user_gated';

export interface Wallet {
  readonly id: string;
  readonly name: string;
  readonly chain: 'ethereum' | 'bitcoin';
  readonly provider: string;
  readonly mode: WalletMode;
  readonly address: string | null;
  /** Derived for display from the grants; the API answers with grant rows. */
  agents: string[];
  policies: string[];
  readonly balances: readonly { readonly asset: string; readonly raw: string; readonly unit: string; readonly label: string }[];
  readonly status: 'LIVE' | 'SUPERSEDED';
}

export type PolicyVersionStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED';

export interface PolicyVersion {
  readonly id: string;
  readonly policyId: string;
  readonly number: number;
  readonly status: PolicyVersionStatus;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly createdBy: string;
  readonly summary: string;
  /** Present on every reactivation, because `014` requires one. */
  readonly justification: string | null;
  readonly document: PolicyDocumentShape;
}

/** The subset of `PolicyDocument` the interface renders. Field names match the schema. */
export interface PolicyDocumentShape {
  readonly meta: { readonly name: string; readonly description: string | null };
  readonly target: { readonly walletId: string; readonly authorityMode: WalletMode; readonly signatureTriple: string };
  readonly permissions: {
    readonly transfers: {
      readonly enabled: boolean;
      readonly chains: readonly string[];
      readonly assets: readonly { readonly kind: string; readonly chain: string; readonly contract?: string; readonly symbol?: string; readonly decimals?: string }[];
      readonly recipients: { readonly mode: 'allowlist'; readonly addresses: readonly string[] };
      readonly perTransaction: { readonly maxRaw: string; readonly unit: string };
      readonly perDay: { readonly maxRaw: string; readonly unit: string };
      readonly perMonth: { readonly maxRaw: string; readonly unit: string } | null;
      readonly maxTransactionsPerHour: number;
    };
    readonly contractCalls: { readonly enabled: boolean; readonly contracts: readonly string[] };
    readonly newRecipients: { readonly allowed: boolean; readonly requireApproval: boolean };
  };
  readonly escalation: {
    readonly humanApproval: {
      readonly requiredWhen: readonly { readonly op: string; readonly raw?: string; readonly unit?: string; readonly level?: string; readonly days?: number; readonly count?: number; readonly cents?: string; readonly window?: string }[];
      readonly approverRoles: readonly string[];
      readonly quorumEnforcement: 'application';
      readonly quorum: number;
    };
  };
  readonly validity: {
    readonly transactionTtlSeconds: number;
    readonly notBefore: string | null;
    readonly notAfter: string | null;
    readonly signingBudget: { readonly maxIkaRawPerDay: string; readonly alertAtIkaRawPerDay: string };
  };
  readonly fallback: {
    readonly onUnknownTransaction: 'deny';
    readonly onEvaluationError: 'deny';
    readonly onRiskUnavailable: 'deny' | 'escalate';
    readonly onSimulationUnavailable: 'allow_advisory' | 'deny';
  };
  readonly limits: { readonly maxUsdEstimateAgeSeconds: number; readonly maxDeadlineSkewSeconds: number };
}

// ---------------------------------------------------------------------------
// Transactions and their trace
// ---------------------------------------------------------------------------

export type CandidateKind = 'transfer' | 'contract_call' | 'unknown';

/** One stage of the pipeline, as the audit trail actually records it. */
export interface TraceStage {
  readonly name: 'INTENT' | 'POLICY' | 'RISK' | 'APPROVAL' | 'SIGNING' | 'EXECUTION';
  readonly state: 'PASSED' | 'ESCALATED' | 'BLOCKED' | 'NOT_REACHED' | 'ADVISORY' | 'UNSETTLED';
  readonly at: string | null;
  readonly headline: string;
  readonly detail: readonly string[];
  readonly codes: readonly ReasonCode[];
  /** The audit event ids this stage was reconstructed from. The "why" is never decorative. */
  readonly events: readonly string[];
}

export interface TransactionRecord {
  readonly id: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly kind: CandidateKind;
  readonly intent: string;
  readonly asset: string;
  readonly unit: string;
  readonly amountRaw: string | null;
  readonly recipient: string | null;
  readonly contract: string | null;
  readonly chain: string;
  readonly digest: string;
  readonly policyVersionId: string;
  readonly policyName: string;
  readonly policyVersionNumber: number;
  readonly state: LifecycleState;
  readonly outcome: DecisionOutcome;
  readonly codes: readonly ReasonCode[];
  readonly risk: RiskAssessment | null;
  readonly submittedAt: string;
  readonly decidedAt: string;
  readonly trace: readonly TraceStage[];
  readonly ticket: { readonly id: string; readonly mintedAt: string; readonly expiresAt: string; readonly redeemedAt: string | null } | null;
  readonly approval: { readonly id: string; readonly quorum: number; readonly votes: number } | null;
  readonly idempotencyKey: string;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly amountRaw: string | null;
  readonly unit: string;
  readonly asset: string;
  readonly recipient: string | null;
  readonly reason: string;
  readonly policyVersionId: string;
  readonly policyName: string;
  readonly policyVersionNumber: number;
  readonly riskLevel: RiskLevel;
  readonly riskSignals: readonly RiskSignalName[];
  readonly why: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly quorum: number;
  readonly votes: readonly { readonly by: string; readonly role: string; readonly at: string; readonly decision: 'APPROVED' | 'REJECTED' }[];
  readonly requiredRole: string;
  readonly digest: string;
  readonly status: 'PENDING' | 'GRANTED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED';
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type ActorType = 'agent' | 'human' | 'system';

export interface AuditEvent {
  readonly seq: string;
  readonly id: string;
  readonly at: string;
  readonly type: string;
  readonly actor: string;
  readonly actorType: ActorType;
  readonly resource: string | null;
  readonly resourceId: string | null;
  readonly request: string | null;
  readonly policyVersion: string | null;
  readonly decision: string | null;
  readonly reasons: readonly string[];
  readonly severity: 'info' | 'notice' | 'warning' | 'critical';
  readonly prev: string;
  readonly hash: string;
  readonly meta: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Derived helpers: the UI's only inferences, kept where they can be read
// ---------------------------------------------------------------------------

/**
 * `AWAITING_APPROVAL` and `ANOMALOUS` are not stored anywhere: they are this surface's
 * reading of live rows. Naming the derivation in one function is what keeps a badge from
 * becoming a claim about the engine. An agent is never "anomalous" to Ari's schema, it is
 * an agent whose most recent assessment crossed a threshold.
 */
export function deriveAgentState(
  status: AgentStatus,
  pendingApprovals: number,
  highestRecentRisk: RiskLevel | null,
): AgentSurfaceState {
  if (status === 'REVOKED') return 'REVOKED';
  if (highestRecentRisk === 'HIGH' || highestRecentRisk === 'CRITICAL') return 'ANOMALOUS';
  if (pendingApprovals > 0) return 'AWAITING_APPROVAL';
  return status;
}

export const RISK_ORDER: readonly RiskLevel[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export function riskAtLeast(level: RiskLevel, floor: RiskLevel): boolean {
  return RISK_ORDER.indexOf(level) >= RISK_ORDER.indexOf(floor);
}
