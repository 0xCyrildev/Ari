import type { CompiledPolicy } from '../src/index.js';
import { compilePolicy, type EvaluationState } from '../src/index.js';
import {
  CandidateTransaction,
  PolicyDocument,
  type CandidateTransaction as Candidate,
  type PolicyDocument as PolicyDoc,
  type RiskAssessment,
} from '@ari/schemas';

export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
export const NOVEL = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';
const UUID = '0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';

export const POLICY_ID = `pol_${UUID}`;
export const VERSION_ID = `ppv_${UUID}`;
export const NOW_MS = BigInt(Date.parse('2026-09-25T11:00:00.000Z'));

/** The unit every limit and amount in this fixture speaks. */
export const UNIT = 'usdc-6dp';

/** 2,000 units — the per-transaction ceiling. */
export const CAP = 2000000000n;
/** Half the cap: under the per-transaction limit and under the escalation threshold. */
export const PERMITTED = 500000000n;
/** The `amount_gt` escalation threshold in the fixture policy. */
export const ESCALATE_ABOVE = 1000000000n;
export const DAY_CAP = 25000000000n;
export const MONTH_CAP = 200000000000n;

export function doc(overrides: Record<string, unknown> = {}): PolicyDoc {
  const parsed = PolicyDocument.safeParse({
    meta: { name: 'accounts-payable', description: null },
    target: {
      walletId: `wal_${UUID}`,
      authorityMode: 'user_gated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
    },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 }],
        recipients: { mode: 'allowlist', addresses: [RECIPIENT] },
        perTransaction: { maxRaw: CAP.toString(), unit: UNIT },
        perDay: { maxRaw: DAY_CAP.toString(), unit: UNIT },
        perMonth: { maxRaw: MONTH_CAP.toString(), unit: UNIT },
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: true },
    },
    escalation: {
      humanApproval: {
        requiredWhen: [{ op: 'amount_gt', raw: ESCALATE_ABOVE.toString(), unit: UNIT }],
        approverRoles: ['owner'],
        quorumEnforcement: 'application',
        quorum: 1,
      },
    },
    validity: {
      transactionTtlSeconds: 900,
      notBefore: null,
      notAfter: '2026-12-31T00:00:00.000Z',
      signingBudget: { maxIkaRawPerDay: '5000000', alertAtIkaRawPerDay: '2500000' },
    },
    fallback: {
      onUnknownTransaction: 'deny',
      onEvaluationError: 'deny',
      onRiskUnavailable: 'escalate',
      onSimulationUnavailable: 'allow_advisory',
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
    ...overrides,
  });
  if (!parsed.success) throw new Error(`policy fixture invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function compiled(overrides: Record<string, unknown> = {}): CompiledPolicy {
  return compilePolicy(doc(overrides), {
    policyId: POLICY_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
  });
}

export function candidate(overrides: Record<string, unknown> = {}): Candidate {
  const parsed = CandidateTransaction.safeParse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: `req_${UUID}`,
    agentId: `agt_${UUID}`,
    walletId: `wal_${UUID}`,
    deadline: '2026-09-25T12:00:00.000Z',
    idempotencyKey: 'inv-1',
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: PERMITTED.toString(), unit: UNIT },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    replayProtection: {
      scheme: 'account_sequence',
      nonce: '12',
      chainId: '1',
      gasLimit: '21000',
      maxFeePerUnit: '20000000000',
      maxPriorityFeePerUnit: '1000000000',
    },
    ...overrides,
  });
  if (!parsed.success) throw new Error(`candidate fixture invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function contractCand(overrides: Record<string, unknown> = {}): Candidate {
  const parsed = CandidateTransaction.safeParse({
    kind: 'contract_call',
    chain: 'ethereum',
    requestId: `req_${UUID}`,
    agentId: `agt_${UUID}`,
    walletId: `wal_${UUID}`,
    deadline: '2026-09-25T12:00:00.000Z',
    idempotencyKey: 'inv-2',
    usdEstimate: null,
    contract: USDC,
    selector: '0xa9059cbb',
    calldata: '0x',
    value: '0',
    replayProtection: {
      scheme: 'account_sequence',
      nonce: '3',
      chainId: '1',
      gasLimit: '21000',
      maxFeePerUnit: '20000000000',
      maxPriorityFeePerUnit: '1000000000',
    },
    ...overrides,
  });
  if (!parsed.success) throw new Error(`contract fixture invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function unknownCand(overrides: Record<string, unknown> = {}): Candidate {
  const parsed = CandidateTransaction.safeParse({
    kind: 'unknown',
    reason: 'chain not supported: sui',
    reportedChain: 'sui',
    requestId: `req_${UUID}`,
    agentId: `agt_${UUID}`,
    walletId: `wal_${UUID}`,
    deadline: '2026-09-25T12:00:00.000Z',
    idempotencyKey: 'inv-3',
    usdEstimate: null,
    ...overrides,
  });
  if (!parsed.success) throw new Error(`unknown fixture invalid: ${parsed.error.message}`);
  return parsed.data;
}

/** The `transfers` block of the fixture policy, for tests that must rewrite it whole. */
export function transfersBlock(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chains: ['ethereum'],
    assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 }],
    recipients: { mode: 'allowlist', addresses: [RECIPIENT] },
    perTransaction: { maxRaw: CAP.toString(), unit: UNIT },
    perDay: { maxRaw: DAY_CAP.toString(), unit: UNIT },
    perMonth: { maxRaw: MONTH_CAP.toString(), unit: UNIT },
    maxTransactionsPerHour: 20,
    ...overrides,
  };
}

/** A policy with the given `permissions.transfers` / `permissions.contractCalls` blocks. */
export function policyWith(permissions: Record<string, unknown>): ReturnType<typeof compiled> {
  return compiled({
    permissions: {
      transfers: transfersBlock(),
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: true },
      ...permissions,
    },
  });
}

/** A policy whose only escalation condition is `condition`, with optional permission overrides. */
export function withCondition(
  condition: Record<string, unknown> | null,
  permissions: Record<string, unknown> = {},
): ReturnType<typeof compiled> {
  return compiled({
    permissions: {
      transfers: transfersBlock(),
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: true },
      ...permissions,
    },
    escalation: {
      humanApproval: {
        requiredWhen: condition === null ? [] : [condition],
        approverRoles: ['owner'],
        quorumEnforcement: 'application',
        quorum: 1,
      },
    },
  });
}

/** A policy whose `validity` block is the fixture one with these fields replaced. */
export function withValidity(validity: Record<string, unknown>): ReturnType<typeof compiled> {
  return compiled({
    validity: {
      transactionTtlSeconds: 900,
      notBefore: null,
      notAfter: '2026-12-31T00:00:00.000Z',
      signingBudget: { maxIkaRawPerDay: '5000000', alertAtIkaRawPerDay: '2500000' },
      ...validity,
    },
  });
}

export function state(overrides: Partial<EvaluationState> = {}): EvaluationState {
  return {
    nowMs: NOW_MS,
    requestId: `req_${UUID}`,
    agentId: `agt_${UUID}`,
    agentStatus: 'ACTIVE',
    scopes: ['transaction:request'],
    usage: {
      reservedDayRaw: 0n,
      reservedMonthRaw: 0n,
      transactionsLastHour: 0,
      ikaSpentTodayRaw: 0n,
    },
    history: {
      baselineAssets: new Set([`erc20:ethereum:${USDC}`]),
      baselineChains: new Set(['ethereum']),
      // A recipient the wallet has paid for a long time: neither novel nor recently seen,
      // so `recipient_first_seen_within_days` is quiet unless a test says otherwise.
      recipientFirstSeenAtMs: NOW_MS - 365n * 86_400_000n,
    },
    // An assessment is the ordinary case now, not an extra: the engine treats a
    // missing one as the fallback the policy named, and the fixture's policy named
    // `escalate`. A test that means "the risk engine did not answer" has to say so
    // with `{ risk: null }`, which is the only way that path gets exercised at all.
    risk: risk('NONE'),
    simulation: null,
    ...overrides,
  };
}

/** A RiskAssessment shaped enough to drive the escalation rules. */
export function risk(level: RiskAssessment['level']): RiskAssessment {
  return {
    requestId: `req_${UUID}`,
    score: level === 'NONE' ? 0 : level === 'CRITICAL' ? 0.99 : 0.5,
    level,
    signals: [],
    explanation: `${level} for the fixture`,
    baselineWindowDays: 30,
    modelVersion: 'fixture-1',
    computedAtMs: NOW_MS,
  };
}
