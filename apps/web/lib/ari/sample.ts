/**
 * Sample tenant data.
 *
 * This is a fixture, not a claim. It is one coherent tenant: an organisation, two wallets,
 * five agents, three policies, and the transactions that connect them, built so that every
 * number on a screen can be traced to another number on another screen: the daily usage on an
 * agent page is the sum of that agent's settled transactions here, the "3 pending" on the
 * sidebar is the length of `approvals`, and the audit events are the ones those decisions
 * would actually have written.
 *
 * Nothing about a chain is invented. There are no block confirmations claimed beyond
 * `BROADCAST`, no balances pulled from thin air, no transaction hash that implies a real
 * settlement Ari has not observed. Where the product does not yet know something, that a
 * signature has been confirmed on-chain, that a wallet's address belongs to the wallet it is
 * recorded against, the fixture says so in the same words the UI uses.
 */

import type {
  AgentStatus,
  ApprovalRequest,
  AuditEvent,
  PolicyDocumentShape,
  PolicyVersion,
  RiskAssessment,
  RiskLevel,
  RiskSignalName,
  Scope,
  TraceStage,
  TransactionRecord,
  Wallet,
} from './types';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const startedAt = Date.now();
const ago = (ms: number): string => new Date(startedAt - ms).toISOString();

// ---------------------------------------------------------------------------
// Identifiers, in the shape `newId()` produces: prefix + UUIDv7
// ---------------------------------------------------------------------------

const hex = '0123456789abcdef';
let counter = 0;
/**
 * Deterministic per load, and shaped like the real thing: a UUIDv7 with its version and
 * variant nibbles in place. A seeded mulberry32 rather than multiply-by-a-constant, because
 * the first version produced ids with long runs of zeros and every digest on screen looked
 * like a placeholder, which reads as a claim about the product, not about the fixture.
 */
function id(prefix: string): string {
  counter += 1;
  let state = (0x9e3779b9 * counter) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nibble = (): string => hex[Math.floor(next() * 16)] ?? '0';
  const group = (length: number): string => Array.from({ length }, nibble).join('');
  return `${prefix}${group(8)}-${group(4)}-7${group(3)}-8${group(3)}-${group(12)}`;
}

const ORG = id('org');
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const UNIT = 'usdc-6dp';
const usd = (whole: number): string => (BigInt(Math.round(whole * 1_000_000))).toString();

// ---------------------------------------------------------------------------
// People, wallets, agents
// ---------------------------------------------------------------------------

export const organization = {
  id: ORG,
  name: 'Halden Freight Group',
  environment: 'production' as const,
  region: 'eu-west-1',
  plan: 'Enterprise',
  createdAt: ago(214 * DAY),
};

export const users = [
  { id: id('usr'), email: 'yusuf@haldenfreight.test', name: 'Yusuf Demir', role: 'owner', status: 'ACTIVE' as const },
  { id: id('usr'), email: 'halima@haldenfreight.test', name: 'Halima Osei', role: 'admin', status: 'ACTIVE' as const },
  { id: id('usr'), email: 'nils@haldenfreight.test', name: 'Nils Bekker', role: 'approver', status: 'ACTIVE' as const },
  { id: id('usr'), email: 'tomas@haldenfreight.test', name: 'Tomas Wenzel', role: 'approver', status: 'SUSPENDED' as const },
];

export const wallets: Wallet[] = [
  {
    id: id('wal'),
    name: 'treasury-main',
    chain: 'ethereum',
    provider: 'ika-dwallet',
    mode: 'delegated',
    address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    agents: [],
    policies: [],
    balances: [{ asset: 'USDC', raw: usd(1_284_500.42), unit: UNIT, label: 'usdc-6dp' }],
    status: 'LIVE',
  },
  {
    id: id('wal'),
    name: 'ops-settlement',
    chain: 'ethereum',
    provider: 'ika-dwallet',
    mode: 'user_gated',
    address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    agents: [],
    policies: [],
    balances: [{ asset: 'USDC', raw: usd(96_400), unit: UNIT, label: 'usdc-6dp' }],
    status: 'LIVE',
  },
  {
    id: id('wal'),
    name: 'legacy-cold',
    chain: 'bitcoin',
    provider: 'ika-dwallet',
    mode: 'user_gated',
    address: null,
    agents: [],
    policies: [],
    balances: [],
    status: 'SUPERSEDED',
  },
];

interface AgentSeed {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly status: AgentStatus;
  readonly wallet: number;
  readonly policy: string;
  readonly scopes: readonly Scope[];
  readonly lastActivity: number;
  readonly owner: string;
  readonly created: number;
}

export const agents: AgentSeed[] = [
  {
    id: id('agt'),
    name: 'treasury-agent',
    purpose: 'Settles approved vendor invoices from the operating balance, Monday to Friday.',
    status: 'ACTIVE',
    wallet: 0,
    policy: 'treasury-payments',
    scopes: ['transaction:request'],
    lastActivity: 6 * MIN,
    owner: users[0]!.email,
    created: 168 * DAY,
  },
  {
    id: id('agt'),
    name: 'payroll-runner',
    purpose: 'Monthly payroll batch to a fixed list of 42 recipient addresses.',
    status: 'ACTIVE',
    wallet: 0,
    policy: 'payroll-fixed',
    scopes: ['transaction:request'],
    lastActivity: 19 * HOUR,
    owner: users[1]!.email,
    created: 121 * DAY,
  },
  {
    id: id('agt'),
    name: 'bridge-observer',
    purpose: 'Reads counterparty balances; may move funds only with a human signature.',
    status: 'ACTIVE',
    wallet: 1,
    policy: 'ops-limits',
    scopes: ['transaction:request', 'transaction:read'],
    lastActivity: 41 * MIN,
    owner: users[2]!.email,
    created: 44 * DAY,
  },
  {
    id: id('agt'),
    name: 'yield-sweeper',
    purpose: 'Sweeps idle USDC into a money-market allowance. Paused pending review.',
    status: 'PAUSED',
    wallet: 0,
    policy: 'ops-limits',
    scopes: ['transaction:request'],
    lastActivity: 3 * DAY,
    owner: users[1]!.email,
    created: 77 * DAY,
  },
  {
    id: id('agt'),
    name: 'legacy-migrator',
    purpose: 'One-off migration between the old and new treasury wallets.',
    status: 'REVOKED',
    wallet: 2,
    policy: 'ops-limits',
    scopes: ['transaction:request'],
    lastActivity: 62 * DAY,
    owner: users[0]!.email,
    created: 190 * DAY,
  },
];

export const agentByName = (name: string): AgentSeed | undefined => agents.find((a) => a.name === name);
export const agentIdByName = (name: string): string => agentByName(name)?.id ?? name;
export const walletById = (walletId: string): Wallet | undefined => wallets.find((w) => w.id === walletId);
export const walletByName = (name: string): Wallet | undefined => wallets.find((w) => w.name === name);

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function documentFor(
  name: string,
  walletName: string,
  caps: { readonly perTx: number; readonly perDay: number; readonly perMonth?: number; readonly hourly: number },
  escalations: readonly { op: string; raw?: string; unit?: string; level?: RiskLevel; days?: number; count?: number; cents?: string; window?: string }[],
  mode: 'delegated' | 'user_gated',
  overrides: Partial<Pick<PolicyDocumentShape['permissions'], 'contractCalls' | 'newRecipients'>> = {},
  fallback: Partial<PolicyDocumentShape['fallback']> = {},
): PolicyDocumentShape {
  const wallet = walletByName(walletName)
  // The triple names the scheme the signer will run, which follows the chain. Authority mode
  // says who has to be present, not what algorithm signs.
  const signatureTriple = wallet?.chain === 'bitcoin' ? 'SECP256K1/Taproot/SHA256' : 'SECP256K1/ECDSASecp256k1/KECCAK256'
  return {
    meta: { name, description: `${name}. Deterministic limits, no wildcard recipients.` },
    target: {
      walletId: wallet?.id ?? '',
      authorityMode: mode,
      signatureTriple,
    },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: '6' }],
        recipients: {
          mode: 'allowlist',
          addresses:
            name === 'Payroll fixed list'
              ? ['0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c', '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9', '0x2f6a1c9d4b8e7f0a5c3d1e9b7a5c3d1e9b7a5c3d']
              : ['0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c', '0x1111111111111111111111111111111111111111'],
        },
        perTransaction: { maxRaw: usd(caps.perTx), unit: UNIT },
        perDay: { maxRaw: usd(caps.perDay), unit: UNIT },
        perMonth: caps.perMonth === undefined ? null : { maxRaw: usd(caps.perMonth), unit: UNIT },
        maxTransactionsPerHour: caps.hourly,
      },
      contractCalls: overrides.contractCalls ?? { enabled: false, contracts: [] },
      newRecipients: overrides.newRecipients ?? { allowed: false, requireApproval: false },
    },
    escalation: {
      humanApproval: {
        requiredWhen: escalations.map((e) => e as never) as PolicyDocumentShape['escalation']['humanApproval']['requiredWhen'],
        approverRoles: ['owner', 'approver'],
        quorumEnforcement: 'application',
        quorum: name === 'Payroll fixed list' ? 2 : 1,
      },
    },
    validity: {
      transactionTtlSeconds: 900,
      notBefore: null,
      notAfter: null,
      signingBudget: { maxIkaRawPerDay: '5000000', alertAtIkaRawPerDay: '2500000' },
    },
    fallback: {
      onUnknownTransaction: 'deny',
      onEvaluationError: 'deny',
      onRiskUnavailable: 'escalate',
      onSimulationUnavailable: 'allow_advisory',
      ...fallback,
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
  };
}

interface PolicySeed {
  readonly key: string;
  readonly name: string;
  readonly versions: PolicyVersion[];
}

function version(policyKey: string, number: number, status: PolicyVersion['status'], ageDays: number, doc: PolicyDocumentShape, summary: string, justification: string | null = null): PolicyVersion {
  return {
    id: id('ppv'),
    policyId: policyKey,
    number,
    status,
    createdAt: ago(ageDays * DAY),
    activatedAt: status === 'DRAFT' ? null : ago(Math.max(0, ageDays - 1) * DAY),
    createdBy: users[0]!.email,
    summary,
    justification,
    document: doc,
  };
}

export const policies: PolicySeed[] = [
  {
    key: 'treasury-payments',
    name: 'Treasury Payments',
    versions: [
      version(
        'treasury-payments',
        8,
        'ACTIVE',
        9,
        documentFor(
          'Treasury Payments',
          'treasury-main',
          { perTx: 10_000, perDay: 25_000, perMonth: 250_000, hourly: 20 },
          [
            { op: 'amount_gt', raw: usd(5_000), unit: UNIT },
            { op: 'recipient_first_seen_within_days', days: 30 },
            { op: 'risk_gte', level: 'MEDIUM' },
          ],
          'delegated',
          { newRecipients: { allowed: true, requireApproval: true } },
        ),
        'Autonomous up to $5,000; a human between $5,000 and $10,000; $25,000 a day, $250,000 a month.',
      ),
      version(
        'treasury-payments',
        7,
        'SUPERSEDED',
        61,
        documentFor('Treasury Payments', 'treasury-main', { perTx: 7_500, perDay: 20_000, hourly: 12 }, [{ op: 'amount_gt', raw: usd(4_000), unit: UNIT }], 'delegated'),
        'Previous ceiling: $4,000 autonomous, $20,000 a day.',
      ),
      version(
        'treasury-payments',
        6,
        'RETIRED',
        148,
        documentFor('Treasury Payments', 'treasury-main', { perTx: 5_000, perDay: 15_000, hourly: 10 }, [{ op: 'amount_gt', raw: usd(2_500), unit: UNIT }], 'delegated'),
        'Retired after the Q2 vendor renegotiation.',
      ),
      version(
        'treasury-payments',
        9,
        'DRAFT',
        1,
        documentFor(
          'Treasury Payments',
          'treasury-main',
          { perTx: 15_000, perDay: 40_000, perMonth: 400_000, hourly: 30 },
          [{ op: 'amount_gt', raw: usd(8_000), unit: UNIT }, { op: 'risk_gte', level: 'HIGH' }],
          'delegated',
          { newRecipients: { allowed: true, requireApproval: true } },
        ),
        'Proposed widening: raises every ceiling and lowers the approval threshold ratio.',
      ),
    ],
  },
  {
    key: 'payroll-fixed',
    name: 'Payroll fixed list',
    versions: [
      version(
        'payroll-fixed',
        3,
        'ACTIVE',
        33,
        documentFor(
          'Payroll fixed list',
          'treasury-main',
          { perTx: 40_000, perDay: 120_000, perMonth: 120_000, hourly: 60 },
          [{ op: 'recipient_not_in_allowlist' }, { op: 'amount_gt', raw: usd(40_000), unit: UNIT }],
          'delegated',
          { newRecipients: { allowed: false, requireApproval: false } },
          { onRiskUnavailable: 'deny' },
        ),
        'Two approvers for anything off the fixed list. Refuses when the risk plane is down.',
      ),
      version('payroll-fixed', 2, 'SUPERSEDED', 121, documentFor('Payroll fixed list', 'treasury-main', { perTx: 30_000, perDay: 100_000, hourly: 40 }, [{ op: 'recipient_not_in_allowlist' }], 'delegated'), 'Before the December headcount increase.'),
    ],
  },
  {
    key: 'ops-limits',
    name: 'Ops limits',
    versions: [
      version(
        'ops-limits',
        4,
        'ACTIVE',
        17,
        documentFor(
          'Ops limits',
          'ops-settlement',
          { perTx: 2_500, perDay: 6_000, hourly: 8 },
          [{ op: 'amount_gt', raw: usd(1_000), unit: UNIT }, { op: 'risk_gte', level: 'MEDIUM' }, { op: 'time_out_of_hours_window', window: 'eu-working-hours' }],
          'user_gated',
          { contractCalls: { enabled: true, contracts: ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d'] } },
          { onSimulationUnavailable: 'deny' },
        ),
        'Small, human-gated, and refuses when the chain cannot be asked.',
      ),
      version('ops-limits', 3, 'SUPERSEDED', 96, documentFor('Ops limits', 'ops-settlement', { perTx: 2_000, perDay: 5_000, hourly: 6 }, [{ op: 'amount_gt', raw: usd(800), unit: UNIT }], 'user_gated'), 'Previous small-payment envelope.'),
    ],
  },
];

export const policyVersionById = (versionId: string): { policy: PolicySeed; version: PolicyVersion } | undefined => {
  for (const policy of policies) {
    const found = policy.versions.find((v) => v.id === versionId);
    if (found !== undefined) return { policy, version: found };
  }
  return undefined;
};

export const activeVersion = (key: string): PolicyVersion => {
  const policy = policies.find((p) => p.key === key);
  return policy?.versions.find((v) => v.status === 'ACTIVE') ?? policy?.versions[0]!;
};

for (const agent of agents) {
  const wallet = wallets[agent.wallet]!;
  wallet.agents = [...wallet.agents, agent.name];
  const policy = policies.find((p) => p.key === agent.policy)!;
  const active = activeVersion(policy.key);
  if (!wallet.policies.includes(`${policy.name} v${active.number}`)) wallet.policies = [...wallet.policies, `${policy.name} v${active.number}`];
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

function risk(level: RiskLevel, signals: readonly RiskSignalName[], score: number, ageMs: number): RiskAssessment {
  return { level, signals, score, baselineWindowDays: 30, modelVersion: 'behavioural-v3', computedAt: ago(ageMs) };
}

// ---------------------------------------------------------------------------
// Transactions, and the traces that explain them
// ---------------------------------------------------------------------------

function stage(
  name: TraceStage['name'],
  state: TraceStage['state'],
  at: number | null,
  headline: string,
  detail: readonly string[],
  codes: TraceStage['codes'] = [],
): TraceStage {
  return { name, state, at: at === null ? null : ago(at), headline, detail, codes, events: [id('aud')] };
}

interface TxSeed {
  readonly agent: string;
  readonly wallet: number;
  readonly policyKey: string;
  readonly versionNumber: number;
  readonly intent: string;
  readonly amount: number | null;
  readonly recipient?: string;
  readonly contract?: string;
  readonly kind?: 'transfer' | 'contract_call';
  readonly ageMs: number;
  readonly outcome: TransactionRecord['outcome'];
  readonly state: TransactionRecord['state'];
  readonly codes: TransactionRecord['codes'];
  readonly risk: RiskAssessment | null;
  readonly note?: string;
}

const RECIPIENTS = {
  brightline: '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c',
  vector: '0x8d2f4b61a0c9e7d35b2f8a14c6e0d9b7f3a25c18',
  novus: '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9',
  unknown: '0x2f6a1c9d4b8e7f0a5c3d1e9b7a5c3d1e9b7a5c3d',
};

const seeds: TxSeed[] = [
  {
    agent: 'treasury-agent', wallet: 0, policyKey: 'treasury-payments', versionNumber: 8,
    intent: 'Pay Brightline Cartage, invoice INV-2291', amount: 4_200, recipient: RECIPIENTS.brightline, ageMs: 6 * MIN,
    outcome: 'ALLOW', state: 'SIGNING_COMPLETE', codes: [], risk: risk('LOW', [], 0.12, 6 * MIN),
    note: 'Signature returned by the mock provider; not yet reconciled against a chain fact.',
  },
  {
    agent: 'treasury-agent', wallet: 0, policyKey: 'treasury-payments', versionNumber: 8,
    intent: 'Pay Vector Logistics, invoice INV-2288', amount: 8_500, recipient: RECIPIENTS.vector, ageMs: 52 * MIN,
    outcome: 'REQUIRE_HUMAN_APPROVAL', state: 'APPROVAL_PENDING', codes: ['HUMAN_APPROVAL_REQUIRED'], risk: risk('MEDIUM', ['AMOUNT_ABOVE_BASELINE'], 0.41, 52 * MIN),
  },
  {
    agent: 'treasury-agent', wallet: 0, policyKey: 'treasury-payments', versionNumber: 8,
    intent: 'Pay Novus Freight, invoice INV-2287', amount: 3_100, recipient: RECIPIENTS.novus, ageMs: 3 * HOUR,
    outcome: 'DENY', state: 'DENIED', codes: ['RECIPIENT_NOT_IN_ALLOWLIST'], risk: risk('MEDIUM', ['NEW_RECIPIENT'], 0.38, 3 * HOUR),
  },
  {
    agent: 'treasury-agent', wallet: 0, policyKey: 'treasury-payments', versionNumber: 8,
    intent: 'Pay Brightline Cartage, invoice INV-2280', amount: 12_400, recipient: RECIPIENTS.brightline, ageMs: 7 * HOUR,
    outcome: 'DENY', state: 'DENIED', codes: ['AMOUNT_EXCEEDS_PER_TRANSACTION'], risk: risk('LOW', [], 0.2, 7 * HOUR),
  },
  {
    agent: 'bridge-observer', wallet: 1, policyKey: 'ops-limits', versionNumber: 4,
    intent: 'Approve router spend for the settlement cycle', amount: null, contract: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', kind: 'contract_call', ageMs: 41 * MIN,
    outcome: 'REQUIRE_HUMAN_APPROVAL', state: 'APPROVAL_PENDING', codes: ['HUMAN_APPROVAL_REQUIRED'], risk: risk('MEDIUM', ['OUT_OF_HOURS'], 0.35, 41 * MIN),
    note: 'A `user_gated` wallet: the policy can allow it and the device still has to sign.',
  },
  {
    agent: 'bridge-observer', wallet: 1, policyKey: 'ops-limits', versionNumber: 4,
    intent: 'Pay Brightline Cartage for a courier surcharge', amount: 1_450, recipient: RECIPIENTS.brightline, ageMs: 26 * HOUR,
    outcome: 'ALLOW', state: 'SIGNING_COMPLETE', codes: [], risk: risk('LOW', [], 0.18, 26 * HOUR),
  },
  {
    agent: 'yield-sweeper', wallet: 0, policyKey: 'ops-limits', versionNumber: 4,
    intent: 'Sweep idle balance to the money-market allowance', amount: 2_400, contract: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', kind: 'contract_call', ageMs: 3 * DAY,
    outcome: 'DENY', state: 'DENIED', codes: ['AGENT_PAUSED'], risk: risk('HIGH', ['BEHAVIOUR_PROFILE_DRIFT', 'AMOUNT_8X_BASELINE'], 0.74, 3 * DAY),
  },
  {
    agent: 'payroll-runner', wallet: 0, policyKey: 'payroll-fixed', versionNumber: 3,
    intent: 'Payroll batch, 42 recipients', amount: 118_400, recipient: RECIPIENTS.unknown, ageMs: 19 * HOUR,
    outcome: 'REQUIRE_HUMAN_APPROVAL', state: 'APPROVAL_PENDING', codes: ['HUMAN_APPROVAL_REQUIRED'], risk: risk('LOW', [], 0.22, 19 * HOUR),
    note: 'Two approvers required by policy v3.',
  },
  {
    agent: 'payroll-runner', wallet: 0, policyKey: 'payroll-fixed', versionNumber: 3,
    intent: 'Payroll batch for September', amount: 112_900, recipient: RECIPIENTS.unknown, ageMs: 31 * DAY,
    outcome: 'ALLOW', state: 'BROADCAST_CONFIRMED', codes: [], risk: risk('LOW', [], 0.19, 31 * DAY),
    note: 'The only row in this fixture that claims settlement. No reconciler exists in this build, so read it as the shape of a confirmed row rather than as a chain fact.',
  },
  {
    agent: 'treasury-agent', wallet: 0, policyKey: 'treasury-payments', versionNumber: 8,
    intent: 'Pay a counterparty not seen in 14 months', amount: 2_000, recipient: RECIPIENTS.unknown, ageMs: 5 * DAY,
    outcome: 'DENY', state: 'DENIED', codes: ['SIMULATION_MISMATCH'], risk: risk('MEDIUM', ['NEW_RECIPIENT', 'DORMANT_AGENT_RESUMED'], 0.47, 5 * DAY),
    note: 'The bytes simulated were not the bytes authorised; the pipeline refused rather than pay.',
  },
  {
    agent: 'treasury-agent', wallet: 0, policyKey: 'treasury-payments', versionNumber: 8,
    intent: 'Pay Brightline Cartage, invoice INV-2244', amount: 9_800, recipient: RECIPIENTS.brightline, ageMs: 8 * DAY,
    outcome: 'DENY', state: 'DENIED', codes: ['AMOUNT_EXCEEDS_DAILY_LIMIT', 'LIMIT_RESERVATION_FAILED'], risk: risk('LOW', ['POLICY_BOUNDARY_PROXIMITY'], 0.28, 8 * DAY),
  },
  {
    agent: 'legacy-migrator', wallet: 2, policyKey: 'ops-limits', versionNumber: 3,
    intent: 'Migrate remaining balance to treasury-main', amount: 400, recipient: RECIPIENTS.brightline, ageMs: 62 * DAY,
    outcome: 'DENY', state: 'DENIED', codes: ['AGENT_REVOKED'], risk: null,
  },
];

function traceFor(seed: TxSeed, versionId: string): TraceStage[] {
  // Stage offsets are seconds, not milliseconds: a trace whose six stages all carry the same
  // timestamp says nothing about order, and order is the whole claim the pipeline makes.
  const t = seed.ageMs;
  const s = (seconds: number): number => t - seconds * 1_000;
  const denied = seed.outcome === 'DENY';
  const escalated = seed.outcome === 'REQUIRE_HUMAN_APPROVAL';
  const code = seed.codes[0] ?? null;

  const policyStage = denied
    ? stage('POLICY', 'BLOCKED', s(120), seed.codes.includes('SIMULATION_MISMATCH') ? 'Refused at the simulation arm' : 'Refused', [
        `${seed.policyKey} v${seed.versionNumber} (${versionId})`,
        ...seed.codes.map((c) => `reason ${c.toLowerCase().replaceAll('_', ' ').toLowerCase()}`),
      ], seed.codes)
    : stage('POLICY', escalated ? 'ESCALATED' : 'PASSED', s(120), escalated ? 'Within limits; an escalation condition matched' : 'Allowed', [
        `${seed.policyKey} v${seed.versionNumber} (${versionId})`,
        seed.amount === null ? 'contract call: no transfer limit applies, native value is refused outright' : `within the per-transaction ceiling`,
      ], escalated ? ['HUMAN_APPROVAL_REQUIRED'] : []);

  const riskStage =
    seed.risk === null
      ? stage('RISK', 'NOT_REACHED', null, 'Not assessed', ['the request was refused before the advisory plane ran'])
      : stage('RISK', 'ADVISORY', s(90), `${seed.risk.level.toLowerCase()} · advisory, cannot grant`, [
          `score ${seed.risk.score.toFixed(2)} over a ${seed.risk.baselineWindowDays}-day behavioural window`,
          ...(seed.risk.signals.length > 0 ? seed.risk.signals.map((s) => `signal ${s.toLowerCase().replaceAll('_', ' ')}`) : ['no signals raised']),
          `model ${seed.risk.modelVersion}`,
        ]);

  const approvalStage = escalated
    ? stage('APPROVAL', 'ESCALATED', s(30), 'Waiting on a human', ['quorum and roles are enforced by Ari’s database, not by the browser'])
    : denied
      ? stage('APPROVAL', 'NOT_REACHED', null, 'Not reached', [])
      : stage('APPROVAL', 'PASSED', s(60), seed.codes.length === 0 && seed.risk !== null && seed.state !== 'BROADCAST_CONFIRMED' ? 'Not required' : 'Granted by a named approver', [
          'approval token sealed from the row that recorded the vote',
        ]);

  const signingStage =
    denied || escalated
      ? stage('SIGNING', 'NOT_REACHED', null, 'No ticket was minted', ['a refusal leaves no capability behind, enforced by a trigger rather than by convention'])
      : stage('SIGNING', 'PASSED', s(12), 'Authorized by Ari', [
          `single-use ticket, 60s TTL, sealed digest`,
          `${wallets[seed.wallet]!.name} · ${wallets[seed.wallet]!.mode}`,
        ]);

  const executionStage =
    denied || escalated
      ? stage('EXECUTION', 'NOT_REACHED', null, 'Nothing was broadcast', [])
      : seed.state === 'BROADCAST_CONFIRMED'
        ? stage('EXECUTION', 'PASSED', s(2), 'Confirmed', ['provider-confirmed finality recorded'])
        : stage('EXECUTION', 'UNSETTLED', null, 'Not settled, awaiting confirmation', [
            seed.note ?? 'the signature came from a mock provider; a mock’s word is not a chain fact',
          ]);

  return [
    stage('INTENT', 'PASSED', s(180), seed.intent, [
      `agent ${seed.agent}`,
      seed.amount === null ? 'contract call, no token amount' : `$${seed.amount.toLocaleString('en-US')} USDC to ${seed.recipient ?? seed.contract}`,
      'all amounts cross the wire as decimal strings in the policy’s unit',
    ]),
    policyStage,
    riskStage,
    approvalStage,
    signingStage,
    executionStage,
    ...(code === null ? [] : []),
  ];
}

export const transactions: TransactionRecord[] = seeds.map((seed) => {
  const policy = policies.find((p) => p.key === seed.policyKey)!;
  const version = policy.versions.find((v) => v.number === seed.versionNumber) ?? policy.versions[0]!;
  const requestId = id('req');
  return {
    id: id('txr'),
    requestId,
    agentId: agentIdByName(seed.agent),
    walletId: wallets[seed.wallet]!.id,
    kind: seed.kind ?? 'transfer',
    intent: seed.intent,
    asset: seed.kind === 'contract_call' ? 'none' : 'USDC',
    unit: UNIT,
    amountRaw: seed.amount === null ? null : usd(seed.amount),
    recipient: seed.recipient ?? null,
    contract: seed.contract ?? null,
    chain: 'ethereum',
    digest: `canon/v1:${id('').replaceAll('-', '').slice(0, 40)}`,
    policyVersionId: version.id,
    policyName: policy.name,
    policyVersionNumber: version.number,
    state: seed.state,
    outcome: seed.outcome,
    codes: seed.codes,
    risk: seed.risk,
    submittedAt: ago(seed.ageMs),
    decidedAt: ago(Math.max(0, seed.ageMs - 60_000)),
    trace: traceFor(seed, version.id),
    ticket:
      seed.outcome === 'ALLOW'
        ? {
            id: id('tkt'),
            mintedAt: ago(seed.ageMs - 3_000),
            expiresAt: ago(seed.ageMs - 3_000 + 60_000),
            redeemedAt: ago(seed.ageMs - 2_000),
          }
        : null,
    approval: seed.outcome === 'REQUIRE_HUMAN_APPROVAL' ? { id: id('apr'), quorum: policy.name === 'Payroll fixed list' ? 2 : 1, votes: 0 } : null,
    idempotencyKey: `invoice-${requestId.slice(4, 12)}`,
  };
});

export const transactionById = (idValue: string): TransactionRecord | undefined =>
  transactions.find((t) => t.id === idValue || t.requestId === idValue);

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const approvals: ApprovalRequest[] = transactions
  .filter((t) => t.approval !== null)
  .map((t, index) => {
    const seed = seeds[index]!;
    return {
      id: t.approval!.id,
      requestId: t.requestId,
      agentId: t.agentId,
      walletId: t.walletId,
      amountRaw: t.amountRaw,
      unit: t.unit,
      asset: t.asset,
      recipient: t.recipient ?? t.contract ?? null,
      reason: t.intent,
      policyVersionId: t.policyVersionId,
      policyName: t.policyName,
      policyVersionNumber: t.policyVersionNumber,
      riskLevel: t.risk?.level ?? 'NONE',
      riskSignals: t.risk?.signals ?? [],
      why:
        t.policyName === 'Payroll fixed list'
          ? 'Batch exceeds the autonomous ceiling for a fixed-list policy, and requires two approvers.'
          : 'Transaction exceeds the autonomous spending threshold of $5,000 in this policy version.',
      requestedAt: t.decidedAt,
      expiresAt: ago(seed.ageMs - 15 * MIN),
      quorum: t.approval!.quorum,
      votes: [],
      requiredRole: 'owner or approver',
      digest: t.digest,
      status: 'PENDING',
    };
  });

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

const auditTypes = [
  'transaction.proposed',
  'policy.evaluated',
  'risk.assessed',
  'transaction.state_changed',
  'approval.requested',
  'approval.granted',
  'ticket.minted',
  'reservation.settled',
  'simulation.evaluated',
  'agent.credential_issued' as string,
  'credential.issued',
  'policy.activated',
  'agent.paused',
  'agent.revoked',
  'chain.integrity_check',
];

export const auditEvents: AuditEvent[] = Array.from({ length: 46 }, (_, i) => {
  const n = 46 - i;
  const tx = transactions[i % transactions.length]!;
  const type = auditTypes[i % auditTypes.length]!;
  const actorType: AuditEvent['actorType'] = type.startsWith('transaction.proposed') || type === 'ticket.minted' ? 'agent' : type.startsWith('approval.') ? 'human' : 'system';
  const severity = type === 'agent.revoked' || type.includes('refused') ? 'warning' : i % 11 === 0 ? 'notice' : 'info';
  return {
    seq: String(n),
    id: id('aud'),
    at: ago(i * 27 * MIN + 4 * MIN),
    type,
    actor: actorType === 'agent' ? agentIdByName(tx.agentId === agents[0]!.id ? 'treasury-agent' : 'bridge-observer') : actorType === 'human' ? users[i % 3]!.id : 'system',
    actorType,
    resource: type.startsWith('approval') ? 'approval_request' : type.startsWith('ticket') ? 'signing_ticket' : 'transaction_request',
    resourceId: tx.id,
    request: tx.requestId,
    policyVersion: tx.policyVersionId,
    decision: type === 'policy.evaluated' ? tx.outcome : null,
    reasons: type === 'policy.evaluated' ? [...tx.codes] : [],
    severity,
    prev: '',
    hash: '',
    meta: (
      type === 'simulation.evaluated'
        ? { simStatus: 'SIMULATED_OK', simChainId: '1', simBlock: '0x15ab6e0', simTrustworthy: 'false', simBound: 'true' }
        : type === 'risk.assessed'
          ? { riskLevel: tx.risk?.level ?? 'NONE', riskScore: (tx.risk?.score ?? 0).toFixed(2), riskModel: 'behavioural-v3' }
          : {}) as AuditEvent['meta'],
  };
});

/**
 * The chain, linked.
 *
 * `prev` and `hash` are filled in a second pass, oldest row to newest, so every row's `prev` is
 * the row before it's `hash` and the newest row's `hash` is the head the console reports. The
 * first version derived both from `n * 7919`, which produced sixteen-nibble strings of leading
 * zeros: a hash column of `0000000000` on a screen whose whole claim is that the history can be
 * verified reads as a stub, and it was. These are still fixture digests, not sha256 over the
 * row, and no screen claims they are.
 */
(function linkChain(): void {
  let link = digest('ari-sample-genesis');
  for (let index = auditEvents.length - 1; index >= 0; index -= 1) {
    const event = auditEvents[index]!;
    const hash = digest(`${link}|${event.seq}|${event.type}`);
    auditEvents[index] = { ...event, prev: link, hash };
    link = hash;
  }
})();

/** A 16-nibble digest from a string seed: the shape of a chain link, deterministic per load. */
function digest(seed: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ (seed.charCodeAt(index) ?? 0), 0x01000193) >>> 0;
  }
  const step = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 16 }, () => hex[Math.floor(step() * 16)] ?? '0').join('');
}

// ---------------------------------------------------------------------------
// Developer surface
// ---------------------------------------------------------------------------

export const apiKeys = [
  { id: id('key'), name: 'treasury-agent · production', prefix: 'crd_01a0df', scopes: ['transaction:request'] as Scope[], created: ago(168 * DAY), lastUsed: ago(6 * MIN), expires: ago(-30 * DAY), status: 'ACTIVE' as const },
  { id: id('key'), name: 'payroll-runner · production', prefix: 'crd_01a0c2', scopes: ['transaction:request'] as Scope[], created: ago(121 * DAY), lastUsed: ago(19 * HOUR), expires: ago(-9 * DAY), status: 'ACTIVE' as const },
  { id: id('key'), name: 'ops-console · staging', prefix: 'crd_019f4b', scopes: ['transaction:read', 'audit:read'] as Scope[], created: ago(58 * DAY), lastUsed: ago(11 * DAY), expires: ago(-2 * DAY), status: 'EXPIRED' as const },
  { id: id('key'), name: 'incident-rotation', prefix: 'crd_019e11', scopes: ['transaction:request'] as Scope[], created: ago(96 * DAY), lastUsed: ago(94 * DAY), expires: null, status: 'REVOKED' as const },
];

export const webhooks = [
  { id: id('whk'), url: 'https://hooks.haldenfreight.test/ari/decisions', events: ['transaction.decided', 'approval.requested'], status: 'HEALTHY' as const, lastDelivery: ago(9 * MIN), failures: 0 },
  { id: id('whk'), url: 'https://erp.haldenfreight.test/ari/settled', events: ['ticket.redeemed', 'broadcast.confirmed'], status: 'RETRYING' as const, lastDelivery: ago(2 * HOUR), failures: 4 },
];

export const environments = [
  { key: 'production', label: 'production', base: 'https://ari.haldenfreight.test', status: 'LIVE' as const, agents: 5, wallets: 3 },
  { key: 'staging', label: 'staging', base: 'https://ari-staging.haldenfreight.test', status: 'LIVE' as const, agents: 2, wallets: 1 },
  { key: 'sandbox', label: 'sandbox', base: 'https://ari-sandbox.haldenfreight.test', status: 'PAUSED' as const, agents: 0, wallets: 0 },
];

// ---------------------------------------------------------------------------
// Derived figures: computed from the rows above, never typed in twice
// ---------------------------------------------------------------------------

const settledStates = new Set(['SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED']);

export function usageFor(agentName: string): { settledRaw: bigint; count: number; lastAt: string | null } {
  const agentId = agentIdByName(agentName);
  let settledRaw = 0n;
  let count = 0;
  let lastAt: string | null = null;
  for (const tx of transactions) {
    if (tx.agentId !== agentId || tx.amountRaw === null) continue;
    count += 1;
    if (settledStates.has(tx.state)) settledRaw += BigInt(tx.amountRaw);
    if (lastAt === null || tx.submittedAt > lastAt) lastAt = tx.submittedAt;
  }
  return { settledRaw, count, lastAt };
}

export function todayTotals(): { authorizedRaw: bigint; count: number; denied: number; pending: number } {
  let authorizedRaw = 0n;
  let count = 0;
  let denied = 0;
  const cutoff = Date.now() - DAY;
  for (const tx of transactions) {
    if (Date.parse(tx.submittedAt) < cutoff) continue;
    count += 1;
    if (settledStates.has(tx.state) && tx.amountRaw !== null) authorizedRaw += BigInt(tx.amountRaw);
    if (tx.outcome === 'DENY') denied += 1;
  }
  return { authorizedRaw, count, denied, pending: approvals.filter((a) => a.status === 'PENDING').length };
}

export function riskEvents(): { level: RiskLevel; signals: readonly RiskSignalName[]; tx: TransactionRecord }[] {
  return transactions
    .filter((t) => t.risk !== null && t.risk.signals.length > 0)
    .map((t) => ({ level: t.risk!.level, signals: t.risk!.signals, tx: t }))
    .sort((a, b) => b.tx.risk!.score - a.tx.risk!.score);
}

/** The one number in this file that is not derived from a row: the fixture's own label. */
export const DEMO_BANNER = 'Sample tenant. No live Ari deployment is connected to this screen, and nothing below it is a chain fact.';
