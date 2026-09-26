/**
 * The risk plane against a database that has history in it.
 *
 * The baselines are aggregates over rows Ari wrote when it authorised something, so
 * they can only be tested where those rows exist — and what is under test is the
 * population as much as the arithmetic. "Which requests count as behaviour" is the
 * question an approver's decision rests on, and it is a decision: an authorised request
 * counts, a denied one does not, and a request that is replaying itself does not count
 * as two.
 *
 * Observed history is written directly rather than earned by minting eight tickets,
 * because minting eight tickets tests the pipeline (which has its own suite) and would
 * still not let a row be sixty days old.
 */

import { authorize, type AuthorizeOutcome, type PipelineDeps } from '@ari/api';
import { appendEvent, verifyChain, type SafeLogFields } from '@ari/audit';
import {
  asTenant,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  grantWalletToAgent,
  issueCredential,
  type Connector,
  type Scope,
} from '@ari/identity';
import { activateVersion, createPolicy } from '@ari/policies';
import { behaviouralProvider, type RiskOutcome, type RiskSubject } from '@ari/risk-engine';
import { CandidateTransaction, PolicyDocument, newId } from '@ari/schemas';
import { ApprovalKey } from '@ari/approvals';
import { TicketKey } from '@ari/signing';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './database.js';

let pool: Pool;
let appPool: Pool;
const app: Connector = {
  async connect(): Promise<PoolClient> {
    const client = await appPool.connect();
    await client.query(`SET ROLE ari_app`);
    return client;
  },
};

const TICKET_KEY = new TicketKey('k'.repeat(48));
const APPROVAL_KEY = new ApprovalKey('a'.repeat(48));
const PEPPER = 'risk-test-pepper-0123456789abcdef';
const NOW = BigInt(Date.parse('2026-09-26T09:00:00.000Z'));

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const REGULAR = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const STRANGER = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';
const NOVEL_CONTRACT = '0x1111111111111111111111111111111111111111';
const UNIT = 'usdc-6dp';
const usd = (whole: bigint) => whole * 1_000_000n;
const DAY = 86_400_000n;

const deps: PipelineDeps = {
  pool: app,
  ticketKey: TICKET_KEY,
  approvalKey: APPROVAL_KEY,
  masterPepper: PEPPER,
  nowMs: () => NOW,
  risk: behaviouralProvider(),
};

beforeAll(async () => {
  pool = await connect();
  appPool = await connect(4);
});

afterAll(async () => {
  await appPool?.end();
  await pool?.end();
});

interface World {
  readonly orgId: string;
  readonly owner: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly credentialId: string;
}

type Escalation = PolicyDocument['escalation']['humanApproval']['requiredWhen'][number];

function documentFor(walletId: string, conditions: readonly Escalation[], riskFallback: 'deny' | 'escalate'): PolicyDocument {
  return {
    meta: { name: 'risk-fixture', description: null },
    target: { walletId, authorityMode: 'delegated', signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256' },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6n }],
        recipients: { mode: 'allowlist', addresses: [REGULAR, STRANGER] },
        perTransaction: { maxRaw: usd(5_000n).toString(), unit: UNIT },
        perDay: { maxRaw: usd(5_000n).toString(), unit: UNIT },
        perMonth: null,
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: true, requireApproval: false },
    },
    escalation: {
      humanApproval: {
        requiredWhen: [...conditions],
        approverRoles: ['owner'],
        quorumEnforcement: 'application',
        quorum: 1,
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
      onRiskUnavailable: riskFallback,
      onSimulationUnavailable: 'allow_advisory',
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
  };
}

async function world(
  conditions: readonly Escalation[] = [],
  riskFallback: 'deny' | 'escalate' = 'escalate',
): Promise<World> {
  const orgId = await createOrganization(app, { name: 'Risk Co', bootstrapActor: 'bootstrap' });
  const owner = await asTenant(app, orgId, (tx) =>
    createUser(tx, { email: `o${orgId.slice(4, 10)}@risk.test`, displayName: 'O', role: 'owner', grantedBy: 'bootstrap' }),
  );
  return asTenant(app, orgId, async (tx) => {
    const agentId = await createAgent(tx, { name: 'payer', createdBy: owner });
    const walletId = await createWallet(tx, {
      displayName: 'ops',
      mode: 'delegated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      provider: 'mock',
      actor: owner,
    });
    const created = await createPolicy(tx, { name: 'risk-fixture', document: documentFor(walletId, conditions, riskFallback), actor: owner });
    await activateVersion(tx, { policyId: created.policyId, versionId: created.versionId, actor: owner });
    await grantWalletToAgent(tx, { agentId, walletId, policyVersionId: created.versionId, actor: owner });
    const issued = await issueCredential(tx, {
      agentId,
      scopes: ['transaction:request'] as Scope[],
      ttlMs: 3_600_000n,
      masterPepper: PEPPER,
      actor: owner,
    });
    return { orgId, owner, agentId, walletId, credentialId: issued.credentialId };
  });
}

interface Observed {
  readonly amount: bigint;
  readonly recipient?: string;
  readonly state?: 'TICKET_MINTED' | 'DENIED' | 'APPROVAL_PENDING';
  readonly agoMs?: bigint;
  readonly idempotencyKey?: string;
}

/**
 * A request that already happened, written as the row the baseline reads.
 *
 * The idempotency key comes from a counter rather than the entry index because a test
 * calls this more than once for the same agent, and `transaction_requests` keys
 * `(agent_id, idempotency_key)` uniquely — the second batch would collide with the first.
 */
let seeded = 0;

async function observed(w: World, entries: readonly Observed[]): Promise<void> {
  await asTenant(app, w.orgId, async (tx) => {
    for (const entry of entries) {
      seeded += 1;
      const at = new Date(Number(NOW - (entry.agoMs ?? 2n * DAY))).toISOString();
      await tx.client.query(
        `INSERT INTO ari.transaction_requests
           (id, org_id, agent_id, wallet_id, idempotency_key, canonical, digest,
            lifecycle_state, created_at, updated_at, recipient_address, amount_raw, currency_unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12)`,
        [
          newId('txr'),
          w.orgId,
          w.agentId,
          w.walletId,
          entry.idempotencyKey ?? `history-${seeded}`,
          `canonical-${seeded}`,
          `01${String(seeded).padStart(62, '0')}`,
          entry.state ?? 'TICKET_MINTED',
          at,
          entry.recipient ?? REGULAR,
          entry.amount.toString(),
          UNIT,
        ],
      );
    }
  });
}

function subject(w: World, over: Partial<RiskSubject> = {}): RiskSubject {
  return {
    requestId: newId('req'),
    idempotencyKey: crypto.randomUUID(),
    agentId: w.agentId,
    walletId: w.walletId,
    nowMs: NOW,
    amountRaw: usd(100n),
    currencyUnit: UNIT,
    isTransfer: true,
    recipientAddress: REGULAR,
    perTransactionCapRaw: usd(5_000n),
    ...over,
  };
}

async function assess(w: World, over: Partial<RiskSubject> = {}): Promise<RiskOutcome> {
  return asTenant(app, w.orgId, (tx) => behaviouralProvider().assess(tx, subject(w, over)));
}

/** Unwrap the one outcome these tests care about, so the assertions read as facts. */
async function signals(w: World, over: Partial<RiskSubject> = {}): Promise<string[]> {
  const outcome = await assess(w, over);
  if (!outcome.ok) throw new Error(`assessment failed: ${outcome.code} ${outcome.detail}`);
  return [...outcome.assessment.signals];
}

function candidateOf(w: World, amount: bigint, recipient: string, key: string) {
  const parsed = CandidateTransaction.safeParse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId: w.agentId,
    walletId: w.walletId,
    deadline: new Date(Number(NOW) + 600_000).toISOString(),
    idempotencyKey: key,
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: amount.toString(), unit: UNIT },
    recipient: { chain: 'ethereum', address: recipient },
    replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: null, maxFeePerUnit: null },
  });
  if (!parsed.success) throw new Error(`candidate fixture invalid: ${parsed.error.message}`);
  return parsed.data;
}

const state = (outcome: AuthorizeOutcome): string => ('status' in outcome ? outcome.status : 'unknown');

describe('what counts as behaviour', () => {
  it('says there is nothing to compare a first request against, rather than calling it clean', async () => {
    const w = await world();
    const outcome = await assess(w);
    if (!outcome.ok) throw new Error('expected an assessment');
    expect(outcome.assessment.signals).toContain('NO_BEHAVIOUR_BASELINE');
    // `NONE` would be the quietest answer available, and an agent with no history has
    // not earned it.
    expect(outcome.assessment.level).toBe('MEDIUM');
  });

  it('counts an authorised request and not a denied one', async () => {
    const w = await world();
    await observed(w, [{ amount: usd(100n), recipient: REGULAR }, { amount: usd(100n), recipient: STRANGER, state: 'DENIED' }]);
    const novel = await signals(w, { recipientAddress: STRANGER });
    expect(novel).toContain('NEW_RECIPIENT');
    const familiar = await signals(w, { recipientAddress: REGULAR });
    expect(familiar).not.toContain('NEW_RECIPIENT');
  });

  it('does not let a request count as its own history', async () => {
    const w = await world();
    const key = 'the-same-request';
    // An earlier attempt of this exact request reached a ticket. Comparing the retry
    // against a history containing it would let one payment set its own baseline.
    await observed(w, [{ amount: usd(900n), state: 'TICKET_MINTED', idempotencyKey: key }]);
    const outcome = await assess(w, { idempotencyKey: key, amountRaw: usd(900n) });
    if (!outcome.ok) throw new Error('expected an assessment');
    expect(outcome.assessment.signals).toContain('NO_BEHAVIOUR_BASELINE');
    expect(outcome.assessment.signals).not.toContain('AMOUNT_8X_BASELINE');
  });

  it('ignores a request against a different wallet', async () => {
    const w = await world();
    await observed(w, [{ amount: usd(100n) }]);
    const other = await asTenant(app, w.orgId, async (tx) => {
      const walletId = await createWallet(tx, {
        displayName: 'other',
        mode: 'delegated',
        signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
        provider: 'mock',
        actor: w.owner,
      });
      return walletId;
    });
    const outcome = await assess(w, { walletId: other });
    if (!outcome.ok) throw new Error('expected an assessment');
    expect(outcome.assessment.signals).toEqual(['NO_BEHAVIOUR_BASELINE']);
  });
});

describe('the measurements', () => {
  it('names eight times the median as the heavy one it is', async () => {
    const w = await world();
    await observed(w, [1n, 2n, 3n, 4n, 5n, 6n].map((n) => ({ amount: usd(100n + n) })));
    const outcome = await assess(w, { amountRaw: usd(900n) });
    if (!outcome.ok) throw new Error('expected an assessment');
    expect(outcome.assessment.signals).toContain('AMOUNT_8X_BASELINE');
    // The median of 101..106 dollars is 103, so nine hundred is 8.7 times it. Stated
    // as the arithmetic rather than as "eight times", because the sentence an approver
    // reads has to be the number that produced the signal.
    expect(outcome.assessment.explanation).toMatch(/8\.7×/);
  });

  it('is unimpressed by a payment near the median', async () => {
    const w = await world();
    await observed(w, [1n, 2n, 3n, 4n, 5n, 6n].map((n) => ({ amount: usd(100n + n) })));
    const signalsSeen = await signals(w, { amountRaw: usd(103n) });
    expect(signalsSeen).not.toContain('AMOUNT_ABOVE_BASELINE');
    expect(signalsSeen).not.toContain('AMOUNT_8X_BASELINE');
  });

  it('reads the hour of day only against an agent that has hours of history', async () => {
    const w = await world();
    // Eight requests an hour ago, and none at this hour: the population is the same
    // agent, the amount the same, so the only thing that can fire is the clock.
    await observed(
      w,
      Array.from({ length: 8 }, (_, i) => ({ amount: usd(100n), agoMs: 3_600_000n + BigInt(i) * 1_000n })),
    );
    expect(await signals(w, { amountRaw: usd(100n) })).toContain('OUT_OF_HOURS');

    // And the same question about an agent with two requests in its life is not a
    // warning; it is two requests.
    const thin = await world();
    await observed(thin, [{ amount: usd(100n), agoMs: 3_600_000n }, { amount: usd(100n), agoMs: 3_600_001n }]);
    expect(await signals(thin, { amountRaw: usd(100n) })).not.toContain('OUT_OF_HOURS');
  });

  it('notices an agent that has been quiet for three weeks', async () => {
    const w = await world();
    await observed(w, [{ amount: usd(100n), agoMs: 20n * DAY }]);
    expect(await signals(w, { amountRaw: usd(100n) })).toContain('DORMANT_AGENT_RESUMED');
    // Inside the window the same request is not dormant, which is the difference
    // between a resumed agent and a Tuesday.
    const active = await world();
    await observed(active, [{ amount: usd(100n), agoMs: 2n * DAY }]);
    expect(await signals(active, { amountRaw: usd(100n) })).not.toContain('DORMANT_AGENT_RESUMED');
  });

  it('counts a day of recipients against the subject of the request, not the server', async () => {
    // The regression this exists for: the 24-hour slice was bound one parameter off, so
    // it compared against `to_timestamp(17)` — 1970-01-01 — and every row was after it.
    // "Distinct recipients in the last day" silently meant "ever", and because that
    // population is also the denominator of the ratio, the signal became a constant for
    // any agent with a few days of history: it fired on ordinary behaviour and stopped
    // distinguishing anything, which is the failure mode that never shows up as red.
    const calm = await world();
    await observed(
      calm,
      Array.from({ length: 20 }, (_, i) => ({
        amount: usd(100n),
        recipient: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        agoMs: BigInt(i + 1) * DAY,
      })),
    );
    // Twenty distinct recipients over twenty days is one a day, and today has brought none.
    const quiet = await assess(calm, { amountRaw: usd(100n), recipientAddress: `0x${'1'.repeat(40)}` });
    if (!quiet.ok) throw new Error('expected an assessment');
    expect(quiet.assessment.signals).not.toContain('RECIPIENT_VELOCITY_CHANGE');

    // The same agent, four new recipients inside an hour, has changed what it does.
    const surge = await world();
    await observed(
      surge,
      Array.from({ length: 20 }, (_, i) => ({
        amount: usd(100n),
        recipient: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        agoMs: BigInt(i + 2) * DAY,
      })),
    );
    await observed(surge, [
      { amount: usd(100n), recipient: '0xaaaa000000000000000000000000000000000001', agoMs: 60_000n },
      { amount: usd(100n), recipient: '0xaaaa000000000000000000000000000000000002', agoMs: 120_000n },
      { amount: usd(100n), recipient: '0xaaaa000000000000000000000000000000000003', agoMs: 180_000n },
      { amount: usd(100n), recipient: '0xaaaa000000000000000000000000000000000004', agoMs: 240_000n },
    ]);
    const busy = await assess(surge, { amountRaw: usd(100n), recipientAddress: STRANGER });
    if (!busy.ok) throw new Error('expected an assessment');
    expect(busy.assessment.signals).toContain('RECIPIENT_VELOCITY_CHANGE');
  });

  it('does not call every contract call a first-time recipient', async () => {
    // `contract_call` carries a recipient in the candidate schema — the contract being
    // called — and that address is never written to `transaction_requests.recipient_address`,
    // which only transfers populate. Deriving novelty from a column that can only ever be
    // absent for that shape flagged every contract call as a first encounter, forever.
    const w = await world();
    await observed(w, [{ amount: usd(100n) }, { amount: usd(100n) }, { amount: usd(100n) }]);
    const asTransfer = await assess(w, { recipientAddress: NOVEL_CONTRACT, isTransfer: true });
    const asCall = await assess(w, { recipientAddress: NOVEL_CONTRACT, isTransfer: false, amountRaw: 0n });
    if (!asTransfer.ok || !asCall.ok) throw new Error('expected assessments');
    expect(asTransfer.assessment.signals).toContain('NEW_RECIPIENT');
    expect(asCall.assessment.signals).not.toContain('NEW_RECIPIENT');
  });

  it('measures the median against payments, not against everything', async () => {
    // A percentile ignores NULLs when ordering but counts them in its denominator, so a
    // wallet whose history is mostly non-payments had its median drawn from a population
    // that includes them — a median that drifts upward as unrelated traffic arrives, which
    // is the direction that makes an unusually large payment look ordinary.
    const w = await world();
    await observed(
      w,
      [1n, 2n, 3n, 4n].map((n) => ({ amount: usd(100n * n), recipient: REGULAR })).concat(
        Array.from({ length: 40 }, () => ({ amount: usd(1n), recipient: REGULAR })),
      ),
    );
    expect(await signals(w, { amountRaw: usd(900n) })).toContain('AMOUNT_8X_BASELINE');
  });

  it('flags a payment sitting under the ceiling by one unit', async () => {
    const w = await world();
    await observed(w, [1n, 2n, 3n].map((n) => ({ amount: usd(100n * n) })));
    expect(await signals(w, { amountRaw: usd(4_600n) })).toContain('POLICY_BOUNDARY_PROXIMITY');
  });
});

describe('the gate: a level can escalate a payment and can never release one', () => {
  it('sends a HIGH assessment to a human when the policy asks for that', async () => {
    const w = await world([{ op: 'risk_gte', level: 'HIGH' }]);
    await observed(w, [1n, 2n, 3n, 4n, 5n, 6n].map((n) => ({ amount: usd(100n + n) })));
    const outcome = await authorize(deps, w.orgId, {
      credentialId: w.credentialId,
      agentId: w.agentId,
      candidate: candidateOf(w, usd(900n), STRANGER, 'risky-1'),
      idempotencyKey: 'risky-1',
    });
    expect(state(outcome)).toBe('AWAITING_APPROVAL');
    if (outcome.status !== 'AWAITING_APPROVAL') return;
    expect(outcome.approvalId).toMatch(/^apr_/);
  });

  it('does not send an ordinary payment to a human for the same policy', async () => {
    const w = await world([{ op: 'risk_gte', level: 'HIGH' }]);
    await observed(w, [1n, 2n, 3n, 4n, 5n, 6n].map((n) => ({ amount: usd(100n + n) })));
    const outcome = await authorize(deps, w.orgId, {
      credentialId: w.credentialId,
      agentId: w.agentId,
      candidate: candidateOf(w, usd(103n), REGULAR, 'boring-1'),
      idempotencyKey: 'boring-1',
    });
    expect(state(outcome)).toBe('TICKET_ISSUED');
  });

  it('keeps a refusal a refusal whatever the assessment says', async () => {
    // The direction A6 is about: risk can move ALLOW to REVIEW, and cannot move DENY
    // to anything. An over-cap payment is refused here with the noisiest history a
    // high score can produce, because the money check runs before the risk stage.
    const w = await world([{ op: 'risk_gte', level: 'HIGH' }]);
    await observed(w, [1n, 2n, 3n, 4n, 5n, 6n].map((n) => ({ amount: usd(100n + n) })));
    const outcome = await authorize(deps, w.orgId, {
      credentialId: w.credentialId,
      agentId: w.agentId,
      candidate: candidateOf(w, usd(9_000n), STRANGER, 'over-cap'),
      idempotencyKey: 'over-cap',
    });
    expect(state(outcome)).toBe('DENIED');
    if (outcome.status !== 'DENIED') return;
    expect(outcome.codes).toContain('AMOUNT_EXCEEDS_PER_TRANSACTION');
    expect(outcome.codes).not.toContain('RISK_ESCALATION_REQUIRED');
  });
});

describe('the gate: an unavailable risk engine is a decision, not a pass', () => {
  const broken: typeof deps.risk = {
    async assess(): Promise<RiskOutcome> {
      return { ok: false, code: 'RISK_QUERY_FAILED', detail: 'forced failure for the test' };
    },
  };

  it('escalates when the policy said escalate', async () => {
    const w = await world([], 'escalate');
    const outcome = await authorize({ ...deps, risk: broken }, w.orgId, {
      credentialId: w.credentialId,
      agentId: w.agentId,
      candidate: candidateOf(w, usd(100n), REGULAR, 'no-risk-escalate'),
      idempotencyKey: 'no-risk-escalate',
    });
    expect(state(outcome)).toBe('AWAITING_APPROVAL');
  });

  it('denies when the policy said deny', async () => {
    const w = await world([], 'deny');
    const outcome = await authorize({ ...deps, risk: broken }, w.orgId, {
      credentialId: w.credentialId,
      agentId: w.agentId,
      candidate: candidateOf(w, usd(100n), REGULAR, 'no-risk-deny'),
      idempotencyKey: 'no-risk-deny',
    });
    expect(state(outcome)).toBe('DENIED');
    if (outcome.status !== 'DENIED') return;
    expect(outcome.codes).toContain('RISK_ENGINE_UNAVAILABLE');
  });

  it('records which of the two it did, in the chain', async () => {
    const w = await world([], 'deny');
    await authorize({ ...deps, risk: broken }, w.orgId, {
      credentialId: w.credentialId,
      agentId: w.agentId,
      candidate: candidateOf(w, usd(100n), REGULAR, 'no-risk-audit'),
      idempotencyKey: 'no-risk-audit',
    });
    const rows = await asTenant(app, w.orgId, (tx) =>
      tx.client.query<{ event_type: string; metadata: Record<string, unknown> }>(
        `SELECT event_type, metadata FROM ari.audit_events WHERE org_id = $1 AND event_type IN ('risk.assessed','risk.unavailable') ORDER BY seq`,
        [w.orgId],
      ),
    );
    const event = rows.rows.find((entry) => entry.event_type === 'risk.unavailable');
    expect(event?.metadata.code).toBe('RISK_QUERY_FAILED');
    expect(await verifyChain(pool, w.orgId)).toMatchObject({ ok: true });
  });

  it('writes the assessment itself into the audit trail, not just its consequence', async () => {
    const w = await world();
    await observed(w, [1n, 2n, 3n, 4n, 5n, 6n].map((n) => ({ amount: usd(100n + n) })));
    const outcome = await authorize(deps, w.orgId, {
      credentialId: w.credentialId,
      agentId: w.agentId,
      candidate: candidateOf(w, usd(900n), STRANGER, 'audited-risk'),
      idempotencyKey: 'audited-risk',
    });
    expect(state(outcome)).toBe('TICKET_ISSUED');
    const rows = await asTenant(app, w.orgId, (tx) =>
      tx.client.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM ari.audit_events WHERE org_id = $1 AND event_type = 'risk.assessed' ORDER BY seq DESC LIMIT 1`,
        [w.orgId],
      ),
    );
    const metadata = rows.rows[0]?.metadata ?? {};
    expect(metadata.riskSignals).toEqual(expect.arrayContaining(['AMOUNT_8X_BASELINE', 'NEW_RECIPIENT']));
    expect(typeof metadata.riskScore).toBe('string');
    expect(metadata.riskModel).toMatch(/risk-baselines/);
    // The prose an engine generates is not a log field: an approver reads the numbers,
    // and the explanation stays with the assessment that carried it.
    expect(metadata).not.toHaveProperty('explanation');
  });
});

describe('the plane that reads history does not write it', () => {
  it('refuses to let a caller put something unloggable in the metadata', async () => {
    const w = await world();
    // `as unknown as SafeLogFields` is the shape of the attack the allowlist exists
    // for: a caller who has a typed object and a name that is not in it. The runtime
    // check is what stands between that and an audit trail that quietly records prose an
    // external engine wrote.
    const smuggled = { riskScore: '0.78', explanation: 'written by the engine, not by Ari' } as unknown as SafeLogFields;
    await expect(
      asTenant(app, w.orgId, (tx) =>
        appendEvent(tx, {
          orgId: w.orgId,
          actor: 'system',
          actorType: 'system',
          eventType: 'risk.assessed',
          resource: 'transaction_request',
          resourceId: newId('txr'),
          metadata: smuggled,
        }),
      ),
    ).rejects.toThrow(/explanation/);
  });
});
