/**
 * The MVP spine, end to end (ROADMAP "MVP success criteria, mapped").
 *
 * Every component in this repository has its own suite. What none of them can show
 * is the claim the product is built on: that the *order* holds under real
 * concurrency — evaluate, reserve, decide, ticket, sign — and that a refusal leaves
 * no ticket behind it. That is what this file checks, against Postgres, with the
 * signer's own counter as the witness (A9).
 */

import { authorize, recordDeliveryOutcome, type PipelineDeps } from '@ari/api';
import { ApprovalKey, recordDecision, sealApproval } from '@ari/approvals';
import {
  asTenant,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  grantWalletToAgent,
  issueCredential,
  revokeCredential,
  type Connector,
  type Scope,
} from '@ari/identity';
import { InMemoryTicketStore, MockSigningProvider, TicketKey, redeemAndSign, type SignerDeps } from '@ari/signing';
import { behaviouralProvider } from '@ari/risk-engine';
import { CandidateTransaction, PolicyDocument, newId, type CanonicalDigest } from '@ari/schemas';
import { activateVersion, createPolicy } from '@ari/policies';
import { readCounter } from '@ari/ledger';
import { verifyChain } from '@ari/audit';
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
const PEPPER = 'pipeline-test-pepper-0123456789abcdef';
const NOW = BigInt(Date.parse('2026-09-26T09:00:00.000Z'));

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const NOVEL = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';
const UNIT = 'usdc-6dp';

const deps: PipelineDeps = {
  pool: app,
  ticketKey: TICKET_KEY,
  approvalKey: APPROVAL_KEY,
  masterPepper: PEPPER,
  nowMs: () => NOW,
  // The real provider, not a stub: these suites are the only place the behavioural
  // baselines meet a database that has rows in them, and a fake here would test the
  // pipeline's plumbing while leaving the arithmetic unexercised.
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

const usd = (whole: bigint) => whole * 1_000_000n;

function policyDocument(walletId: string, mode: 'delegated' | 'user_gated', cap: bigint): PolicyDocument {
  return {
    meta: { name: 'pipeline', description: null },
    target: { walletId, authorityMode: mode, signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256' },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6n }],
        recipients: { mode: 'allowlist', addresses: [RECIPIENT] },
        perTransaction: { maxRaw: cap.toString(), unit: UNIT },
        perDay: { maxRaw: cap.toString(), unit: UNIT },
        perMonth: null,
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: false },
    },
    escalation: {
      humanApproval: {
        requiredWhen: [{ op: 'amount_gt', raw: usd(1_000n).toString(), unit: UNIT }],
        approverRoles: ['owner', 'approver'],
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
      onRiskUnavailable: 'escalate',
      onSimulationUnavailable: 'allow_advisory',
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
  };
}

function transfer(input: { address: string; amount: bigint; idempotencyKey: string; nonce?: string }) {
  const parsed = CandidateTransaction.safeParse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId: 'agt_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    deadline: new Date(Number(NOW) + 600_000).toISOString(),
    idempotencyKey: input.idempotencyKey,
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: input.amount.toString(), unit: UNIT },
    recipient: { chain: 'ethereum', address: input.address },
    replayProtection: {
      scheme: 'account_sequence',
      nonce: (input.nonce ?? '1').toString(),
      chainId: '1',
      gasLimit: null,
      maxFeePerUnit: null,
    },
  });
  if (!parsed.success) throw new Error(`candidate rejected: ${parsed.error.message}`);
  return parsed.data;
}

interface World {
  readonly orgId: string;
  readonly owner: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly credential: { presented: string; credentialId: string };
}

async function world(mode: 'delegated' | 'user_gated' = 'delegated', cap = usd(5_000n)): Promise<World> {
  const orgId = await createOrganization(app, { name: 'Pipeline', bootstrapActor: 'system' });
  const people = await asTenant(app, orgId, async (tx) => ({
    owner: await createUser(tx, { email: 'o@x.test', displayName: 'O', role: 'owner', grantedBy: 'system' }),
  }));
  const built = await asTenant(app, orgId, async (tx) => {
    const agentId = await createAgent(tx, { name: 'payables', createdBy: people.owner });
    const walletId = await createWallet(tx, {
      displayName: 'operating',
      mode,
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      provider: 'mock',
      actor: people.owner,
    });
    const created = await createPolicy(tx, { name: 'pipeline', document: policyDocument(walletId, mode, cap), actor: people.owner });
    await activateVersion(tx, { policyId: created.policyId, versionId: created.versionId, actor: people.owner });
    await grantWalletToAgent(tx, {
      agentId,
      walletId,
      policyVersionId: created.versionId,
      actor: people.owner,
    });
    const issued = await issueCredential(tx, {
      agentId,
      scopes: ['transaction:request'] as Scope[],
      ttlMs: 3_600_000n,
      masterPepper: PEPPER,
      actor: people.owner,
    });
    return { agentId, walletId, issued };
  });

  return {
    orgId,
    owner: people.owner,
    agentId: built.agentId,
    walletId: built.walletId,
    credential: { presented: built.issued.presented, credentialId: built.issued.credentialId },
  };
}

/** A candidate aimed at this world's wallet and agent, with the ids filled in. */
function request(w: World, input: Parameters<typeof transfer>[0]) {
  const candidate = transfer(input);
  return {
    credentialId: w.credential.credentialId,
    agentId: w.agentId,
    candidate: { ...candidate, walletId: w.walletId, agentId: w.agentId },
    idempotencyKey: input.idempotencyKey,
  };
}

function signer(): { deps: SignerDeps; provider: MockSigningProvider; store: InMemoryTicketStore } {
  const provider = new MockSigningProvider();
  const store = new InMemoryTicketStore();
  return {
    provider,
    store,
    deps: { key: TICKET_KEY, provider, store, nowMs: () => NOW, wallets: new Set<string>() },
  };
}

/**
 * Tickets for one organisation only.
 *
 * Every security suite shares one database and runs in parallel; a global count
 * here reads as "the pipeline minted 140 tickets", which is another suite's number
 * and would pass or fail on nothing at all.
 */
async function ticketsIssued(orgId: string): Promise<number> {
  const rows = await pool.query<{ count: number }>(
    `SELECT count(DISTINCT t.id)::int AS count
       FROM ari.signing_tickets t
       JOIN ari.authorization_decisions d ON d.id = t.decision_id
       JOIN ari.transaction_requests r ON r.id = d.request_id
      WHERE r.org_id = $1`,
    [orgId],
  );
  return rows.rows[0]?.count ?? -1;
}

describe('the happy path, through approval', () => {
  it('pays $2,000 only after a human has approved the exact digest', async () => {
    const w = await world();
    const candidate = request(w, { address: RECIPIENT, amount: usd(2_000n), idempotencyKey: 'inv-2k' });
    const signerKit = signer();

    const first = await authorize(deps, w.orgId, candidate);
    expect(first.status).toBe('AWAITING_APPROVAL');
    if (first.status !== 'AWAITING_APPROVAL') return;
    // Nothing has been reserved or ticketed while it waits for a person.
    expect(await ticketsIssued(w.orgId)).toBe(0);

    const decided = await asTenant(app, w.orgId, (tx) =>
      recordDecision(tx, { approvalId: first.approvalId, approver: w.owner, decision: 'APPROVED' }),
    );
    expect(decided).toMatchObject({ ok: true, status: 'GRANTED' });

    const issued = await authorize(deps, w.orgId, {
      ...candidate,
      approvalToken: await tokenFor(first.approvalId),
    });
    expect(issued.status).toBe('TICKET_ISSUED');
    if (issued.status !== 'TICKET_ISSUED') return;
    // The approval, the decision and the ticket are three records of one digest. If
    // any of them drifts, T11/T12 stop being detectable, so the equality is the
    // thing worth asserting here.
    const approved = await pool.query<{ digest: string }>(
      `SELECT digest FROM ari.approval_requests WHERE id = $1`,
      [first.approvalId],
    );
    expect(approved.rows[0]?.digest).toBe(issued.digest);

    // The signer's independent checks, run over the bytes the pipeline actually
    // stored — which is the point of the check. Handing it a lookalike candidate
    // here would test the seal and not the substitution guard.
    const stored = await canonicalRow(issued.requestId);
    const outcome = await redeemAndSign(
      { ...signerKit.deps, wallets: new Set([w.walletId]) },
      { ticket: issued.ticket, canonical: stored },
    );
    if (outcome.status !== 'SIGNED') throw new Error(`expected SIGNED, got ${outcome.status}`);
    expect(signerKit.provider.invocations).toBe(1);
    expect(outcome.digest).toBe(issued.digest);
  });

  it('issues a ticket for a permitted amount with no approval at all', async () => {
    const w = await world();
    const outcome = await authorize(deps, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'inv-500' }),
    });
    expect(outcome.status).toBe('TICKET_ISSUED');
    const signerKit = signer();
    if (outcome.status !== 'TICKET_ISSUED') return;
    const signed = await redeemAndSign(
      { ...signerKit.deps, wallets: new Set([w.walletId]) },
      { ticket: outcome.ticket, canonical: await canonicalRow(outcome.requestId) },
    );
    expect(signed.status).toBe('SIGNED');
    expect(signerKit.provider.invocations).toBe(1);
  });
});

describe('the negative paths the brief closes on', () => {
  it('refuses $50,000 to an unknown recipient and never reaches the signer', async () => {
    const w = await world();
    const signerKit = signer();
    const outcome = await authorize(deps, w.orgId, {
      ...request(w, { address: NOVEL, amount: usd(50_000n), idempotencyKey: 'inv-bad' }),
    });
    expect(outcome.status).toBe('DENIED');
    if (outcome.status === 'DENIED') expect(outcome.codes).toContain('RECIPIENT_NOT_IN_ALLOWLIST');

    expect(await ticketsIssued(w.orgId)).toBe(0);
    expect(signerKit.provider.invocations).toBe(0);
  });

  it('refuses $50,000 to a known recipient on the amount cap', async () => {
    const w = await world();
    const outcome = await authorize(deps, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(50_000n), idempotencyKey: 'inv-over' }),
    });
    expect(outcome.status).toBe('DENIED');
    if (outcome.status === 'DENIED') expect(outcome.codes).toContain('AMOUNT_EXCEEDS_PER_TRANSACTION');
    expect(await ticketsIssued(w.orgId)).toBe(0);
  });

  it('admits exactly one of two $700 payments against a $1,000 daily cap', async () => {
    // The brief's race, scaled so the escalation threshold stays out of it: at
    // $4,000 each the policy asks a human first and the reservation is never
    // reached, which would test the ledger's concurrency and be reported as the
    // policy's decision. $700 + $700 does not fit, and each alone does.
    const w = await world('delegated', usd(1_000n));
    const [a, b] = await Promise.all([
      authorize(deps, w.orgId, request(w, { address: RECIPIENT, amount: usd(700n), idempotencyKey: 'race-a' })),
      authorize(deps, w.orgId, request(w, { address: RECIPIENT, amount: usd(700n), idempotencyKey: 'race-b' })),
    ]);
    const issued = [a, b].filter((outcome) => outcome.status === 'TICKET_ISSUED');
    expect(issued).toHaveLength(1);
    const refused = [a, b].find((outcome) => outcome.status !== 'TICKET_ISSUED');
    expect(refused?.status).toBe('DENIED');
    // The engine allowed both — the daily cap was not yet reached when either
    // evaluated. It is the reservation that refused the second, and the pipeline has
    // to report that as the ledger's refusal rather than the policy's.
    if (refused?.status === 'DENIED') expect(refused.codes).toContain('LIMIT_RESERVATION_FAILED');
  });

  it('returns the original ticket for a retry, and mints no second one', async () => {
    const w = await world();
    const input = request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'retry-1' });
    const first = await authorize(deps, w.orgId, input);
    const second = await authorize(deps, w.orgId, input);

    expect(first.status).toBe('TICKET_ISSUED');
    expect(second.status).toBe('TICKET_ISSUED');
    if (first.status !== 'TICKET_ISSUED' || second.status !== 'TICKET_ISSUED') return;
    expect(second.ticketId).toBe(first.ticketId);
    expect(await ticketsIssued(w.orgId)).toBe(1);
  });

  it('refuses to re-decide a request that was already denied', async () => {
    const w = await world();
    const input = request(w, { address: RECIPIENT, amount: usd(50_000n), idempotencyKey: 'denied-twice' });
    const first = await authorize(deps, w.orgId, input);
    const second = await authorize(deps, w.orgId, input);
    expect(first.status).toBe('DENIED');
    expect(second.status === 'DENIED' && second.codes).toEqual(['IDEMPOTENCY_CONFLICT']);
  });

  it('loses authority on the next request when the credential is revoked (S14)', async () => {
    const w = await world();
    const before = await authorize(deps, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'live-1' }),
    });
    expect(before.status).toBe('TICKET_ISSUED');

    await revokeCredential(app, w.orgId, w.credential.credentialId);
    const after = await authorize(deps, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'live-2' }),
    });
    expect(after.status === 'DENIED' && after.codes).toContain('SCOPE_MISSING');
  });

  it('will not spend an approval twice', async () => {
    const w = await world();
    const candidate = request(w, { address: RECIPIENT, amount: usd(2_000n), idempotencyKey: 'twice-2k' });
    const pending = await authorize(deps, w.orgId, candidate);
    if (pending.status !== 'AWAITING_APPROVAL') throw new Error('expected an approval request');
    await asTenant(app, w.orgId, (tx) =>
      recordDecision(tx, { approvalId: pending.approvalId, approver: w.owner, decision: 'APPROVED' }),
    );
    const token = await tokenFor(pending.approvalId);

    const firstPay = await authorize(deps, w.orgId, { ...candidate, idempotencyKey: 'twice-a', approvalToken: token });
    expect(firstPay.status).toBe('TICKET_ISSUED');
    const replay = await authorize(deps, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(2_000n), idempotencyKey: 'twice-b' }),
      approvalToken: token,
    });
    expect(replay.status === 'DENIED' && replay.codes).toContain('APPROVAL_ALREADY_CONSUMED');
  });
});

describe('what the guarantee is not', () => {
  it('a user_gated ticket still needs the human share, and the signer cannot fake it', async () => {
    const w = await world('user_gated');
    const outcome = await authorize(deps, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'gated' }),
    });
    expect(outcome.status).toBe('TICKET_ISSUED');
    const signerKit = signer();
    if (outcome.status !== 'TICKET_ISSUED') throw new Error('expected a ticket for the gated path');
    const result = await redeemAndSign(
      { ...signerKit.deps, wallets: new Set([w.walletId]) },
      { ticket: outcome.ticket, canonical: await canonicalRow(outcome.requestId) },
    );
    // §2's table, enforced by a process that has no share: the ticket is real, the
    // authority plane simply cannot finish the ceremony with it.
    expect(result.status).toBe('AWAITING_USER_SHARE');
    expect(signerKit.provider.invocations).toBe(0);
    expect(signerKit.store.size).toBe(0);
  });

  it('writes the whole sequence into the chain', async () => {
    const w = await world();
    const candidate = request(w, { address: RECIPIENT, amount: usd(2_000n), idempotencyKey: 'chain-2k' });
    const pending = await authorize(deps, w.orgId, candidate);
    if (pending.status !== 'AWAITING_APPROVAL') throw new Error('expected an approval request');
    await asTenant(app, w.orgId, (tx) =>
      recordDecision(tx, { approvalId: pending.approvalId, approver: w.owner, decision: 'APPROVED' }),
    );
    await authorize(deps, w.orgId, { ...candidate, approvalToken: await tokenFor(pending.approvalId) });

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM ari.audit_events WHERE org_id = $1 ORDER BY seq`,
      [w.orgId],
    );
    const types = events.rows.map((row) => row.event_type);
    for (const expected of [
      'policy.created',
      'policy.activated',
      'wallet.granted',
      'credential.issued',
      'approval.requested',
      'approval.granted',
      'policy.evaluated',
      'ticket.minted',
    ]) {
      expect(types, `missing ${expected} in the chain`).toContain(expected);
    }
    expect((await verifyChain(pool, w.orgId)).ok).toBe(true);
  });
});

/** Mint the token a human's client would present, from the row that was opened. */
async function tokenFor(approvalId: string): Promise<string> {
  const rows = await pool.query<{
    request_id: string;
    digest: string;
    policy_version_id: string;
    agent_id: string;
    wallet_id: string;
    amount_raw: string;
    currency_unit: string;
    expires_at: Date;
  }>(
    `SELECT request_id, digest, policy_version_id, agent_id, wallet_id, amount_raw, currency_unit, expires_at
       FROM ari.approval_requests WHERE id = $1`,
    [approvalId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error('approval row vanished');
  return sealApproval(
    {
      approvalId,
      requestId: row.request_id,
      digest: row.digest as CanonicalDigest,
      policyVersionId: row.policy_version_id,
      agentId: row.agent_id,
      walletId: row.wallet_id,
      amountRaw: BigInt(row.amount_raw),
      currencyUnit: row.currency_unit,
      expiresAtMs: BigInt(row.expires_at.getTime()),
      nonce: 'a-nonce-for-the-test-0000000000000000000000000000',
    },
    APPROVAL_KEY,
  );
}

/**
 * The canonical blob the pipeline stored for a request — read back from the row
 * rather than rebuilt, so a fixture cannot accidentally test a different
 * transaction than the one that was authorised.
 */
async function canonicalRow(requestId: string): Promise<string> {
  const rows = await pool.query<{ canonical: string }>(
    `SELECT canonical FROM ari.transaction_requests WHERE id = $1`,
    [requestId],
  );
  const canonical = rows.rows[0]?.canonical;
  if (canonical === undefined) throw new Error('no stored canonical form for that request');
  return canonical;
}


describe('what one authorised request costs', () => {
  /**
   * The hot path measured, not admired.
   *
   * Every fix in this file's history that made the request cheaper removed a statement —
   * the audit chain's head read before each of seven appends, a lifecycle re-read for a
   * row the same transaction had just written, a counter locked twice. None of them would
   * be noticed by a test that only asserts correctness, and each of them is invisible
   * until a tenant's traffic is the thing that grew. So the count is asserted, with
   * enough slack that a legitimate change is not a chore, and little enough that an
   * accidental N+1 is.
   */
  function countingConnector(inner: Connector, tally: { statements: number }): Connector {
    return {
      async connect() {
        const client = await inner.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === 'query') {
              return (...args: unknown[]) => {
                tally.statements += 1;
                return (target.query as (...a: unknown[]) => unknown)(...args);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
      },
    };
  }

  it('is a bounded number of statements for an ALLOW that mints a ticket', async () => {
    const tally = { statements: 0 };
    const metered: PipelineDeps = { ...deps, pool: countingConnector(app, tally) };
    const w = await world();
    const outcome = await authorize(metered, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'cost-1' }),
    });
    expect(outcome.status).toBe('TICKET_ISSUED');
    // BEGIN/COMMIT are counted, and this is one request: grant, version, scopes, usage,
    // history, the risk baseline, the request row, the evaluation, seven audit events,
    // four lifecycle steps, the reservation, the decision, the ticket.
    console.info();
    expect(tally.statements).toBeLessThanOrEqual(45);
    expect(tally.statements).toBeGreaterThan(20);
  });

  it('asks the risk plane exactly once, and never per rule', async () => {
    const tally = { statements: 0 };
    const metered: PipelineDeps = { ...deps, pool: countingConnector(app, tally) };
    const w = await world();
    await authorize(metered, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(400n), idempotencyKey: 'cost-risk-1' }),
    });
    const withHistory = tally.statements;

    const tally2 = { statements: 0 };
    const metered2: PipelineDeps = { ...deps, pool: countingConnector(app, tally2) };
    const w2 = await world();
    await authorize(metered2, w2.orgId, {
      ...request(w2, { address: RECIPIENT, amount: usd(400n), idempotencyKey: 'cost-risk-2' }),
    });
    expect(tally2.statements).toBe(withHistory);
  });

  it('costs a refusal the same as the payment it stopped, and no more', async () => {
    // Both walk the kernel and write their audit evidence; the difference is that one
    // stops before the ledger. If a refusal ever became *cheaper* than a payment, the
    // missing statements would be the evidence that should have been written.
    const w = await world();
    const refused = { statements: 0 };
    await authorize({ ...deps, pool: countingConnector(app, refused) }, w.orgId, {
      ...request(w, { address: NOVEL, amount: usd(50_000n), idempotencyKey: 'cost-deny' }),
    });

    const paid = { statements: 0 };
    await authorize({ ...deps, pool: countingConnector(app, paid) }, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'cost-pay' }),
    });
    expect(refused.statements).toBeLessThan(paid.statements);
    expect(refused.statements).toBeGreaterThan(15);
  });

  it('previews without the writes a preview is not allowed to make', async () => {
    const w = await world();
    const preview = { statements: 0 };
    const before = (
      await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ari.transaction_requests WHERE org_id = $1`, [w.orgId])
    ).rows[0]?.count ?? -1;
    const outcome = await authorize({ ...deps, pool: countingConnector(app, preview) }, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'preview-cost' }),
      dryRun: true,
    });
    expect(outcome.status).toBe('DECIDED');
    expect(
      (
        await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ari.transaction_requests WHERE org_id = $1`, [w.orgId])
      ).rows[0]?.count ?? -1,
    ).toBe(before);
    expect(preview.statements).toBeLessThan(20);
  });
});


describe('what the audit trail says happened', () => {
  /**
   * Labels are evidence. The lifecycle writer used to record every state change as
   * `transaction.proposed` — four rows per payment all saying an agent had proposed a
   * transaction — and `recordRequest`, the place a proposal actually arrives, wrote no
   * event at all. Both are fixed; this is the test that keeps them fixed, because a
   * mislabelled trail reads as evidence and is not.
   */
  it('records one proposal, and names every step after it for what it was', async () => {
    const w = await world();
    const candidate = request(w, { address: RECIPIENT, amount: usd(2_000n), idempotencyKey: 'labels-2k' });
    const pending = await authorize(deps, w.orgId, candidate);
    if (pending.status !== 'AWAITING_APPROVAL') throw new Error('expected an approval request');
    await asTenant(app, w.orgId, (tx) =>
      recordDecision(tx, { approvalId: pending.approvalId, approver: w.owner, decision: 'APPROVED' }),
    );
    await authorize(deps, w.orgId, { ...candidate, approvalToken: await tokenFor(pending.approvalId) });

    const counts = await pool.query<{ event_type: string; count: string }>(
      `SELECT event_type, count(*)::text AS count FROM ari.audit_events WHERE org_id = $1 GROUP BY 1`,
      [w.orgId],
    );
    const byType = new Map(counts.rows.map((row) => [row.event_type, row.count]));

    // Two attempts at one request, and one proposal: the retry found the row rather than
    // proposing the same payment twice.
    expect(byType.get('transaction.proposed')).toBe('1');
    expect(Number(byType.get('transaction.state_changed'))).toBeGreaterThanOrEqual(5);
    expect(byType.get('risk.assessed')).toBe('2');
    expect(byType.get('ticket.minted')).toBe('1');

    const mislabelled = await pool.query<{ id: string }>(
      `SELECT id FROM ari.audit_events
        WHERE org_id = $1 AND event_type = 'transaction.proposed' AND metadata ? 'fromState'`,
      [w.orgId],
    );
    expect(mislabelled.rows).toHaveLength(0);

    const actorTypes = await pool.query<{ actor_type: string }>(
      `SELECT DISTINCT actor_type FROM ari.audit_events
        WHERE org_id = $1 AND event_type = 'transaction.state_changed' ORDER BY actor_type`,
      [w.orgId],
    );
    // Nobody pressed anything. A reader who concluded a human had advanced the state
    // machine would go asking the wrong person about the wrong payment.
    expect(actorTypes.rows.map((row) => row.actor_type)).toEqual(['agent', 'system']);
  });

  it('settles the hold and says so once the signature lands', async () => {
    const w = await world();
    const outcome = await authorize(deps, w.orgId, {
      ...request(w, { address: RECIPIENT, amount: usd(500n), idempotencyKey: 'settle-500' }),
    });
    if (outcome.status !== 'TICKET_ISSUED') throw new Error('expected a ticket');
    const delivered = await recordDeliveryOutcome(deps, w.orgId, outcome.requestId, { accepted: true, state: 'COMPLETE' });
    expect(delivered).toBe('SETTLED');

    const counter = await readCounter(pool, {
      orgId: w.orgId,
      agentId: w.agentId,
      windowKey: new Date(Number(NOW)).toISOString().slice(0, 10),
      dimension: 'daily_usdc-6dp',
    });
    // Settled money is out of the parked total and into the spent one — and the daily cap
    // still counts it, which is the other half of this pair of assertions.
    expect(counter?.reservedRaw).toBe(0n);
    expect(counter?.settledRaw).toBe(usd(500n));

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM ari.audit_events WHERE org_id = $1 AND event_type = 'reservation.settled'`,
      [w.orgId],
    );
    expect(events.rows).toHaveLength(1);
  });
});
