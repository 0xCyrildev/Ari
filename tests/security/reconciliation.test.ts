/**
 * The reconciliation pass, against the schema it reads and the routes that expose it.
 *
 * Every stuck state here is produced by the code that can produce it — `authorize` for the
 * ticket and the approval, `claimTicket` for the redemption — rather than by an INSERT
 * shaped to match a `WHERE` clause. A fixture written as an insert would prove the query
 * matches itself, which is not a claim worth a test file. Only the two states the pipeline
 * cannot be made to leave behind (an abandoned claim, a request stalled before it decided)
 * are written directly, and each says so where it is written.
 *
 * Age is a parameter, not a migration: `runReconciliation` takes its clock, so "older than
 * the threshold" is produced by asking the pass what it would conclude a week from now.
 * That is the same reason `TenantTx.startedAtMs` is supplied — and it keeps this file free
 * of any `UPDATE … SET updated_at =`, which `ari.touch_updated_at()` would overwrite
 * anyway.
 */

import { authorize, readConfig, startApi, type PipelineDeps, type RunningApi } from '@ari/api';
import { ApprovalKey } from '@ari/approvals';
import { appendEvent, AuditEventType, isAuditEventType, verifyChain } from '@ari/audit';
import {
  asTenant,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  grantWalletToAgent,
  issueCredential,
  issueUserCredential,
  type Scope,
} from '@ari/identity';
import { claimTicket } from '@ari/ledger';
import { activateVersion, createPolicy } from '@ari/policies';
import { FINDING_CODES, recordReport, runReconciliation } from '@ari/reconciliation';
import { behaviouralProvider } from '@ari/risk-engine';
import { CandidateTransaction, PolicyDocument, newId } from '@ari/schemas';
import { TicketKey } from '@ari/signing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, DATABASE_URL,
  testChainBinding,
} from './database.js';

const PEPPER = 'reconciliation-test-pepper-0123456789abcdef';
const TICKET_KEY = new TicketKey('r'.repeat(48));
const APPROVAL_KEY = new ApprovalKey('r'.repeat(48));
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const UNIT = 'usdc-6dp';
const usd = (whole: bigint) => whole * 1_000_000n;

let pool: Awaited<ReturnType<typeof connect>>;
let appPool: Awaited<ReturnType<typeof connect>>;
let deps: PipelineDeps;
let api: RunningApi;
let operator: { presented: string; credentialId: string };
let stuckOrg: string;
let cleanOrg: string;

/** What the pass concludes a week after these rows were written. */
const LATER = () => new Date(Date.now() + 7 * 86_400_000);

function policyDocument(walletId: string, cap: bigint): PolicyDocument {
  return {
    meta: { name: 'reconcile', description: null },
    target: { walletId, authorityMode: 'delegated', signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256' },
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
      onRiskUnavailable: 'escalate',
      onSimulationUnavailable: 'allow_advisory',
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
  };
}

function candidate(walletId: string, agentId: string, amount: bigint, key: string) {
  const parsed = CandidateTransaction.safeParse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId,
    walletId,
    deadline: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: key,
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: amount.toString(), unit: UNIT },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: '21000', maxFeePerUnit: '20000000000', maxPriorityFeePerUnit: '1000000000' },
  });
  if (!parsed.success) throw new Error(`candidate rejected: ${parsed.error.message}`);
  return parsed.data;
}

interface World {
  readonly orgId: string;
  readonly owner: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly credentialId: string;
}

async function world(): Promise<World> {
  const orgId = await createOrganization(appPool, { name: 'Reconcile', bootstrapActor: 'system' });
  const owner = await asTenant(appPool, orgId, async (tx) =>
    createUser(tx, { email: `o-${orgId.slice(4, 12)}@x.test`, displayName: 'O', role: 'owner', grantedBy: 'system' }),
  );
  return asTenant(appPool, orgId, async (tx) => {
    const agentId = await createAgent(tx, { name: 'pay', createdBy: owner });
    const walletId = await createWallet(tx, {
      displayName: 'operating',
      mode: 'delegated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      provider: 'mock',
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      actor: owner,
    });
    const created = await createPolicy(tx, { name: 'reconcile', document: policyDocument(walletId, usd(5_000n)), actor: owner });
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

function ask(w: World, amount: bigint, key: string) {
  return authorize(deps, w.orgId, {
    credentialId: w.credentialId,
    agentId: w.agentId,
    candidate: candidate(w.walletId, w.agentId, amount, key),
    idempotencyKey: key,
  });
}

interface TableCounts {
  readonly transaction_requests: number;
  readonly reservations: number;
  readonly approval_requests: number;
  readonly authorization_decisions: number;
  readonly audit_events: number;
}

async function counts(orgId: string): Promise<TableCounts> {
  const rows = await pool.query<{ table_name: string; n: string }>(
    `SELECT 'transaction_requests' AS table_name, count(*)::text AS n FROM ari.transaction_requests WHERE org_id = $1
     UNION ALL SELECT 'reservations', count(*)::text FROM ari.reservations WHERE org_id = $1
     UNION ALL SELECT 'approval_requests', count(*)::text FROM ari.approval_requests WHERE org_id = $1
     UNION ALL SELECT 'authorization_decisions', count(*)::text FROM ari.authorization_decisions WHERE org_id = $1
     UNION ALL SELECT 'audit_events', count(*)::text FROM ari.audit_events WHERE org_id = $1`,
    [orgId],
  );
  const one = (name: keyof TableCounts): number =>
    Number(rows.rows.find((row) => row.table_name === name)?.n ?? -1);
  return {
    transaction_requests: one('transaction_requests'),
    reservations: one('reservations'),
    approval_requests: one('approval_requests'),
    authorization_decisions: one('authorization_decisions'),
    audit_events: one('audit_events'),
  };
}

/** The count for one finding code, or -1 when the pass did not report it at all. */
function countOf(report: Awaited<ReturnType<typeof runReconciliation>>, code: string): number {
  return report.findings.find((finding) => finding.code === code)?.count ?? -1;
}

beforeAll(async () => {
  pool = await connect();
  appPool = await connect(4);
  deps = {
    chain: testChainBinding,
    pool: appPool,
    ticketKey: TICKET_KEY,
    approvalKey: APPROVAL_KEY,
    masterPepper: PEPPER,
    nowMs: () => BigInt(Date.now()),
    risk: behaviouralProvider(),
    simulation: null,
  };

  // A tenant with nothing stuck in it. Same policy, same wallet, no payment ever asked.
  cleanOrg = (await world()).orgId;

  const w = await world();
  stuckOrg = w.orgId;

  // 1. Minted, never delivered. The state a `TICKET_ISSUED_NOT_DELIVERED` leaves behind.
  const parked = await ask(w, usd(900n), 'park-me');
  if (parked.status !== 'TICKET_ISSUED') throw new Error(`expected a ticket, got ${parked.status}`);

  // 2. Minted, then redeemed by the authority plane — and the decision plane never heard.
  //    This is the crash window between commit and delivery, produced by the two functions
  //    that straddle it rather than by an UPDATE that imitates it.
  const halfDone = await ask(w, usd(900n), 'redeemed-not-recorded');
  if (halfDone.status !== 'TICKET_ISSUED') throw new Error(`expected a ticket, got ${halfDone.status}`);
  const claimed = await asTenant(appPool, w.orgId, (tx) =>
    claimTicket(tx, halfDone.ticketId, halfDone.digest, BigInt(Date.now())),
  );
  expect(claimed).toBe(true);

  // 3. A human was asked, never answered, and the deadline has passed.
  const awaiting = await ask(w, usd(2_000n), 'awaiting');
  if (awaiting.status !== 'AWAITING_APPROVAL') throw new Error(`expected an approval, got ${awaiting.status}`);

  // 4 and 5. Two states the pipeline cannot be made to abandon in place, so they are
  //      written directly — each one a row the application is entitled to write, at a
  //      status the machine allows, and neither touched by a trigger that only fires on
  //      UPDATE.
  const stalled = await pool.query<{ id: string }>(
    `SELECT id FROM ari.transaction_requests WHERE org_id = $1 AND idempotency_key = 'park-me'`,
    [w.orgId],
  );
  const template = stalled.rows[0];
  if (template === undefined) throw new Error('the fixture lost its own request row');
  await asTenant(appPool, w.orgId, async (tx) => {
    await tx.client.query(
      `INSERT INTO ari.transaction_requests
         (id, org_id, agent_id, wallet_id, idempotency_key, canonical, digest, lifecycle_state,
          recipient_address, amount_raw, currency_unit)
       SELECT $1, $2, agent_id, wallet_id, $3, canonical, digest, 'DRAFT', recipient_address, amount_raw, currency_unit
         FROM ari.transaction_requests WHERE id = $4`,
      [newId('txr'), w.orgId, 'stalled-draft', template.id],
    );
    await tx.client.query(
      `INSERT INTO ari.reservations
         (id, org_id, agent_id, request_id, idempotency_key, window_key, dimension, amount_raw, policy_version_id, status)
       SELECT $1, r.org_id, r.agent_id, r.request_id, $2, r.window_key, r.dimension, 1, r.policy_version_id, 'ABANDONED'
         FROM ari.reservations r WHERE r.org_id = $3 AND r.idempotency_key = $4 LIMIT 1`,
      [newId('rsv'), 'abandoned-claim', w.orgId, 'park-me'],
    );
  });

  // The HTTP surface, so the route's own gate is asserted rather than assumed.
  api = await startApi(
    readConfig({
      DATABASE_URL,
      CREDENTIAL_PEPPER: PEPPER,
      TICKET_KEY: 'r'.repeat(48),
      APPROVAL_KEY: 'r'.repeat(48),
      ORG_BOOTSTRAP_TOKEN: 'reconciliation-bootstrap-token',
      LOG_LEVEL: 'silent',
    }),
    { async deliver() { return { accepted: false, code: 'STUB', detail: 'no signer in this suite' }; } },
  );
  const issued = await asTenant(appPool, cleanOrg, async (tx) =>
    issueUserCredential(tx, {
      userId: (await tx.client.query<{ id: string }>(`SELECT id FROM ari.users WHERE org_id = $1 LIMIT 1`, [cleanOrg])).rows[0]!.id,
      scopes: ['audit:read'] as Scope[],
      ttlMs: 3_600_000n,
      masterPepper: PEPPER,
      actor: 'system',
    }),
  );
  operator = { presented: issued.presented, credentialId: issued.credentialId };
});

afterAll(async () => {
  await api?.close();
  await appPool?.end();
  await pool?.end();
});

describe('the pass', () => {
  it('names every stuck state the pipeline can leave behind, and counts them once each', async () => {
    const report = await asTenant(appPool, stuckOrg, (tx) => runReconciliation(tx.client, tx.orgId, LATER()));

    // An approval whose deadline passed with nobody deciding. It holds no capacity —
    // `reserve` is downstream of the approval branch — which is exactly why the query has no
    // join to `reservations`: that predicate would have been a finding that can never fire,
    // and this assertion is what would have caught it. Written as `toBe(1)` against a
    // `HELD`-requiring query, it returned 0, and the reason was the code's, not the test's.
    expect(countOf(report, 'APPROVAL_EXPIRED_UNANSWERED')).toBe(1);
    expect(countOf(report, 'DELIVERY_PARKED')).toBe(1);
    expect(countOf(report, 'TICKET_REDEEMED_NOT_RECORDED')).toBe(1);
    // Exactly one, because the redeemed ticket is excluded by `redeemed_at IS NULL`: this
    // code counts authorisations that were never spent, which is thread 12's question. The
    // spent-but-unrecorded one is a different question, asked by the code above it.
    expect(countOf(report, 'TICKET_MINTED_NOT_REDEEMED')).toBe(1);
    expect(countOf(report, 'ABANDONED_CLAIMS_ACCUMULATED')).toBe(1);
    expect(countOf(report, 'STATE_MACHINE_STALLED')).toBe(1);
    expect(report.findings).toHaveLength(FINDING_CODES.length);
    expect(report.severity).toBe('critical');
    expect(report.total).toBe(6);
  });

  it('is silent about a tenant that finished everything', async () => {
    // The control. A pass that reports the same numbers for both tenants is reading a
    // predicate that ignores its parameter, and every assertion above would still pass.
    const report = await asTenant(appPool, cleanOrg, (tx) => runReconciliation(tx.client, tx.orgId, LATER()));
    expect(report.total).toBe(0);
    expect(report.findings.every((finding) => finding.count === 0)).toBe(true);
    expect(report.severity).toBe('info');
  });

  it('reports nothing about the other tenant, on the table that has no row security', async () => {
    // `signing_tickets` is outside row security by `011`'s documented exception, so the
    // `org_id` predicate in that one query is the whole isolation. A leak here would be a
    // tenant learning another's payment volume from an operator's report.
    const before = await asTenant(appPool, stuckOrg, (tx) => runReconciliation(tx.client, tx.orgId, LATER()));
    expect(countOf(before, 'TICKET_MINTED_NOT_REDEEMED')).toBeGreaterThan(0);

    const report = await asTenant(appPool, cleanOrg, (tx) => runReconciliation(tx.client, tx.orgId, LATER()));
    expect(countOf(report, 'TICKET_MINTED_NOT_REDEEMED')).toBe(0);
    expect(report.findings.every((finding) => finding.oldestId === null)).toBe(true);
  });

  it('reports nothing when the clock says the work is still in progress', async () => {
    // The same rows, judged now rather than a week from now: the threshold is the finding,
    // and a pass that ignored it would call every live payment stuck.
    const report = await asTenant(appPool, stuckOrg, (tx) => runReconciliation(tx.client, tx.orgId, new Date(), { thresholdSeconds: 300 }));
    expect(countOf(report, 'DELIVERY_PARKED')).toBe(0);
    expect(countOf(report, 'STATE_MACHINE_STALLED')).toBe(0);
    expect(countOf(report, 'TICKET_REDEEMED_NOT_RECORDED')).toBe(1);
    // Redemption is not a matter of elapsed time — a spent ticket that the books never
    // acknowledged is an incident the moment it happens.
    expect(report.severity).toBe('critical');
  });

  it('changes nothing except the one event it is asked to write', async () => {
    const before = await counts(stuckOrg);
    const report = await asTenant(appPool, stuckOrg, (tx) => runReconciliation(tx.client, tx.orgId, LATER()));
    const afterRead = await counts(stuckOrg);
    expect(afterRead).toEqual(before);

    await asTenant(appPool, stuckOrg, async (tx) => {
      await recordReport(tx, report);
    });
    const afterWrite = await counts(stuckOrg);
    expect(afterWrite.audit_events).toBe(before.audit_events + 1);
    for (const table of ['transaction_requests', 'reservations', 'approval_requests', 'authorization_decisions'] as const) {
      expect(afterWrite[table]).toBe(before[table]);
    }
  });

  it('leaves the chain intact, because a report is a write like any other', async () => {
    const report = await asTenant(appPool, stuckOrg, (tx) => runReconciliation(tx.client, tx.orgId, LATER()));
    await asTenant(appPool, stuckOrg, async (tx) => {
      await recordReport(tx, report);
    });
    const verified = await asTenant(appPool, stuckOrg, (tx) => verifyChain(tx.client, tx.orgId));
    expect(verified.ok).toBe(true);
  });
});

describe('the event a report becomes', () => {
  it('writes the name this repository owns, and the table holds it verbatim', async () => {
    expect(AuditEventType).toContain('reconciliation.reported');
    const report = await asTenant(appPool, cleanOrg, (tx) => runReconciliation(tx.client, tx.orgId, LATER()));
    await asTenant(appPool, cleanOrg, async (tx) => {
      await recordReport(tx, report);
    });
    const rows = await pool.query<{ event_type: string; metadata: Record<string, unknown>; severity: string }>(
      `SELECT event_type, metadata, severity FROM ari.audit_events WHERE org_id = $1 AND event_type = 'reconciliation.reported'`,
      [cleanOrg],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.event_type).toBe('reconciliation.reported');
    expect(rows.rows[0]?.severity).toBe('info');
    // Counts and codes, no row ids: the event is a witness that the pass ran, and the
    // numbers behind it are re-derivable by running it again.
    expect(JSON.stringify(rows.rows[0]?.metadata)).not.toContain('txr_');
  });

  it('refuses a name that is not in the vocabulary, at the point the row would be written', async () => {
    // `003` gives `event_type` no CHECK, so until now the TypeScript union was the only
    // gate — and a union is erased by the first `as`, by a caller building the input out of
    // a config value, or by anything in JavaScript. A wrong event type does not fail: it
    // reads as evidence, in the one artefact an auditor re-reads.
    expect(isAuditEventType('reconciliation.reported')).toBe(true);
    expect(isAuditEventType('ticket.very_definitely_spent')).toBe(false);
    await expect(
      asTenant(appPool, cleanOrg, async (tx) => {
        await appendEvent(tx, {
          orgId: tx.orgId,
          actor: 'test',
          actorType: 'system',
          // The cast is the point: this is the shape a caller that bypassed the union has.
          eventType: 'ticket.very_definitely_spent' as (typeof AuditEventType)[number],
        });
      }),
    ).rejects.toThrow(/unknown audit event type/);
  });
});

describe('the routes', () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('refuse an agent credential, because the pass is an operator act', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/v1/operations/reconciliation' });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('CREDENTIAL_MISSING');
  });

  it('answer a GET without writing, and a POST with one event', async () => {
    const before = (await counts(cleanOrg)).audit_events;
    const read = await api.app.inject({
      method: 'GET',
      url: '/v1/operations/reconciliation',
      headers: bearer(operator.presented),
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as { total: number; findings: unknown[]; recorded: boolean; organizationId: string };
    expect(body.recorded).toBe(false);
    expect(body.findings).toHaveLength(FINDING_CODES.length);
    expect(body.organizationId).toBe(cleanOrg);
    expect((await counts(cleanOrg)).audit_events).toBe(before);

    const write = await api.app.inject({
      method: 'POST',
      url: '/v1/operations/reconciliation',
      headers: bearer(operator.presented),
    });
    expect(write.statusCode).toBe(200);
    expect((write.json() as { recorded: boolean }).recorded).toBe(true);
    expect((await counts(cleanOrg)).audit_events).toBe(before + 1);
  });

  it('reports the tenant that ran the pass, not the one being watched', async () => {
    // The operator credential belongs to the clean tenant. It cannot ask about the stuck
    // one — and the answer must name the tenant it did look at, so an operator reading a
    // count never has to guess whose it is.
    const response = await api.app.inject({
      method: 'GET',
      url: `/v1/operations/reconciliation?thresholdSeconds=30`,
      headers: bearer(operator.presented),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { organizationId: string }).organizationId).toBe(cleanOrg);
    expect((response.json() as { thresholdSeconds: number }).thresholdSeconds).toBe(30);
  });

  it('refuses a threshold that is not a whole number of seconds', async () => {
    for (const raw of ['abc', '-5', '1e9', '86401', '30; DROP TABLE ari.reservations']) {
      const response = await api.app.inject({
        method: 'GET',
        url: `/v1/operations/reconciliation?thresholdSeconds=${encodeURIComponent(raw)}`,
        headers: bearer(operator.presented),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: 'INVALID_REQUEST', detail: expect.stringContaining('thresholdSeconds') });
    }
    // And the database still has its reservations, which is the only part of that last
    // input that a parameterised query makes true rather than merely likely.
    expect((await counts(cleanOrg)).reservations).toBe(0);
  });
});
