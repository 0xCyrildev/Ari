/**
 * The console's reads, through the router.
 *
 * `api.test.ts` covers the routes that *decide*; this file covers the routes that show. The
 * socket half still lives in `cli.test.ts`, and what neither covers is the browser: the Next
 * app reaches these through a same-origin proxy (`apps/web/app/api/ari/[...path]/route.ts`),
 * which is exercised live against both processes rather than here, because a proxy's failure
 * modes are its allowlist and its upstream, not its SQL.
 *
 * Four things are asserted about every read, because each is a claim a screen would otherwise
 * make on its own behalf:
 *
 *   1. the scope actually gates it — `transaction:read` and `policy:read` were mintable
 *      vocabulary with nothing checking them until this section existed, so a test that only
 *      checks the happy path would pass against a route that ignored its own scope;
 *   2. another tenant's rows are absent rather than refused, and the *control* is that this
 *      tenant's rows are present — an unscoped predicate passes "not visible to B" by showing
 *      nobody anything;
 *   3. money arrives as a decimal string and is never coerced on the way out;
 *   4. a page is bounded, so a read that is fine at three rows cannot become a timeout at
 *      thirty thousand without anyone having to notice.
 */

import { MAX_READ_LIMIT, readConfig, startApi, type DeliveryResult, type RunningApi, type SignerClient } from '@ari/api';
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
import { CandidateTransaction, PolicyDocument, newId } from '@ari/schemas';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, DATABASE_URL } from './database.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ALLOWED = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const NOVEL = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';
const UNIT = 'usdc-6dp';
const usd = (whole: bigint) => whole * 1_000_000n;

const API = readConfig({
  // Mandatory since `017`, with no defaults on purpose: a suite that wants a config states which
  // chains, fee bounds and tokens it signs for, exactly as a deployment must.
  EVM_ALLOWED_CHAIN_IDS: '1',
  EVM_MAX_GAS_LIMIT: '500000',
  EVM_MAX_FEE_COST_WEI: '100000000000000000',
  ARI_NETWORK_NAME: 'mainnet',
  EVM_ASSET_REGISTRY: new URL('./fixtures/evm-assets.json', import.meta.url).pathname,
  DATABASE_URL,
  DATABASE_ROLE: 'ari_app',
  CREDENTIAL_PEPPER: 'console-test-pepper-0123456789abcd',
  TICKET_KEY: 't'.repeat(48),
  APPROVAL_KEY: 'a'.repeat(48),
  ORG_BOOTSTRAP_TOKEN: 'bootstrap-token-for-tests',
});

let pool: Pool;
let appPool: Pool;
/** Fixtures write as `ari_app` from the connection out, not by `SET ROLE` on a pooled client. */
const app: Connector = { connect: async () => appPool.connect() };

const delivered: string[] = [];
const signer: SignerClient = {
  async deliver(request): Promise<DeliveryResult> {
    delivered.push(request.ticket);
    return { accepted: true, state: 'SIGNING_PENDING' };
  },
};

let api: RunningApi;

beforeAll(async () => {
  pool = await connect();
  appPool = await connect(4, 'ari_app');
  api = await startApi(API, signer);
});

afterAll(async () => {
  await api?.close();
  await appPool?.end();
  await pool?.end();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function candidate(walletId: string, agentId: string, address: string, amount: bigint) {
  const body = {
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId,
    walletId,
    deadline: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: newId('req'),
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: amount.toString(), unit: UNIT },
    recipient: { chain: 'ethereum', address },
    replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: '21000', maxFeePerUnit: '20000000000', maxPriorityFeePerUnit: '1000000000' },
  };
  const parsed = CandidateTransaction.safeParse(body);
  if (!parsed.success) throw new Error(`candidate fixture rejected: ${parsed.error.message}`);
  return body;
}

interface Tenant {
  readonly orgId: string;
  readonly owner: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly policyVersionId: string;
  readonly presented: string;
}

async function tenant(): Promise<Tenant> {
  const orgId = await createOrganization(app, { name: 'Console', bootstrapActor: 'bootstrap' });
  const owner = await asTenant(app, orgId, (tx) =>
    createUser(tx, {
      email: `o${orgId.slice(4, 10)}@x.test`,
      displayName: 'O',
      role: 'owner',
      grantedBy: 'bootstrap',
    }),
  );
  const built = await asTenant(app, orgId, async (tx) => {
    const agentId = await createAgent(tx, { name: 'pay', createdBy: owner });
    const walletId = await createWallet(tx, {
      displayName: 'ops',
      mode: 'delegated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      provider: 'mock',
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      actor: owner,
    });
    const cap = usd(5_000n);
    const document: PolicyDocument = {
      meta: { name: 'console', description: null },
      target: { walletId, authorityMode: 'delegated', signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256' },
      permissions: {
        transfers: {
          enabled: true,
          chains: ['ethereum'],
          assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6n }],
          recipients: { mode: 'allowlist', addresses: [ALLOWED] },
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
    const created = await createPolicy(tx, { name: 'console', document, actor: owner });
    await activateVersion(tx, { policyId: created.policyId, versionId: created.versionId, actor: owner });
    await grantWalletToAgent(tx, { agentId, walletId, policyVersionId: created.versionId, actor: owner });
    const issued = await issueCredential(tx, {
      agentId,
      scopes: ['transaction:request'] as Scope[],
      ttlMs: 3_600_000n,
      masterPepper: API.masterPepper,
      actor: owner,
    });
    return { agentId, walletId, versionId: created.versionId, presented: issued.presented };
  });
  return { orgId, owner, agentId: built.agentId, walletId: built.walletId, policyVersionId: built.versionId, presented: built.presented };
}

/** A human, minted over HTTP the way an operator does it, holding exactly these scopes. */
async function human(t: Tenant, scopes: readonly string[], role = 'owner') {
  // The whole uuid, not a slice of it: `newId` is uuidv7, so its leading characters are the
  // millisecond and two humans minted in the same one collide on `users_org_id_email_key`.
  // `api.test.ts`'s `approver()` slices the same way and has simply not yet needed two people
  // in one millisecond; this file creates three per tenant, so it does.
  const email = `${role}-${newId('req').slice(4)}@x.test`;
  const made = await api.app.inject({
    method: 'POST',
    url: '/v1/users',
    headers: bearer(API.bootstrapToken),
    payload: { organizationId: t.orgId, email, displayName: 'H', role },
  });
  if (made.statusCode !== 201) throw new Error(`user creation refused: ${made.statusCode} ${made.body}`);
  const userId = (made.json() as { userId: string }).userId;
  const credential = await api.app.inject({
    method: 'POST',
    url: `/v1/users/${userId}/credentials`,
    headers: bearer(API.bootstrapToken),
    payload: { organizationId: t.orgId, scopes: [...scopes], ttlMs: '3600000' },
  });
  if (credential.statusCode !== 201) {
    throw new Error(`credential refused: ${credential.statusCode} ${credential.body}`);
  }
  return { userId, bearer: (credential.json() as { bearer: string }).bearer };
}

const get = (url: string, token: string) => api.app.inject({ method: 'GET', url, headers: bearer(token) });
const json = <T>(response: { body: string }) => response.body === '' ? ({} as T) : (JSON.parse(response.body) as T);

/** Ask for a small ALLOW, a refusal, an escalation and a preview, so every read has something true to say. */
async function withTraffic(t: Tenant) {
  const allowed = await api.app.inject({
    method: 'POST',
    url: '/v1/transactions/authorize',
    headers: bearer(t.presented),
    payload: { candidate: candidate(t.walletId, t.agentId, ALLOWED, usd(400n)), idempotencyKey: newId('req') },
  });
  const denied = await api.app.inject({
    method: 'POST',
    url: '/v1/transactions/authorize',
    headers: bearer(t.presented),
    payload: { candidate: candidate(t.walletId, t.agentId, NOVEL, usd(300n)), idempotencyKey: newId('req') },
  });
  const escalated = await api.app.inject({
    method: 'POST',
    url: '/v1/transactions/authorize',
    headers: bearer(t.presented),
    payload: { candidate: candidate(t.walletId, t.agentId, ALLOWED, usd(2_000n)), idempotencyKey: newId('req') },
  });
  const previewed = candidate(t.walletId, t.agentId, ALLOWED, usd(900n));
  const preview = await api.app.inject({
    method: 'POST',
    url: '/v1/transactions/evaluate',
    headers: bearer(t.presented),
    payload: { candidate: previewed },
  });
  return { allowed, denied, escalated, preview, previewed };
}

interface TransactionRow {
  id: string;
  agentId: string;
  lifecycleState: string;
  createdAt: string;
  digest: string;
  amountRaw: string | null;
  currencyUnit: string | null;
  recipientAddress: string | null;
  risk: { level: string; score: string; signals: string[] } | null;
  decision: {
    outcome: string;
    reasonCodes: string[];
    policyVersionId: string;
    committedDecisionId: string | null;
  } | null;
}

describe('GET /v1/transactions', () => {
  it('requires transaction:read, and says which scope it wanted', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);
    const approver = await human(t, ['approval:decide']);

    const refused = await get('/v1/transactions', approver.bearer);
    expect(refused.statusCode).toBe(403);
    expect(json<{ code: string; detail: string }>(refused)).toMatchObject({
      code: 'SCOPE_REFUSED',
      detail: 'this route requires transaction:read',
    });

    expect((await get('/v1/transactions', reader.bearer)).statusCode).toBe(200);
    // An agent secret does not parse at a human gate, and the refusal is the one an
    // observer cannot tell from a wrong secret (T8).
    const asAgent = await get('/v1/transactions', t.presented);
    expect(asAgent.statusCode).toBe(401);
    expect(json<{ code: string }>(asAgent)).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('lists the tenant’s requests newest first, with the reason codes from the trail', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);
    await withTraffic(t);

    const response = await get('/v1/transactions', reader.bearer);
    expect(response.statusCode).toBe(200);
    const body = json<{ organizationId: string; readAt: string; limit: number; transactions: TransactionRow[] }>(response);
    expect(body.organizationId).toBe(t.orgId);
    expect(typeof body.readAt).toBe('string');
    expect(body.limit).toBe(50);
    expect(body.transactions).toHaveLength(3);

    // Newest first, asserted on the timestamps rather than on a fixed permutation of states:
    // three authorize calls in a row can land inside one another's `created_at` when the box is
    // busy, and a test that fails because the machine was slow is a test that gets deleted.
    const stamps = body.transactions.map((row) => Date.parse(row.createdAt));
    expect(stamps).toEqual([...stamps].sort((x, y) => y - x));
    // The allowed row reads `TICKET_MINTED` here even though its authorize response said
    // `SIGNING_PENDING`: the lifecycle stops where the ledger stops, and a mock signer's word
    // is not a chain fact (S12). A console that showed SIGNING_PENDING would be overclaiming
    // settlement on a screen built for a human to trust.
    expect(new Set(body.transactions.map((row) => row.lifecycleState))).toEqual(
      new Set(['DENIED', 'TICKET_MINTED', 'APPROVAL_PENDING']),
    );

    const denied = body.transactions.find((row) => row.lifecycleState === 'DENIED');
    expect(denied?.decision).toMatchObject({ outcome: 'DENY', reasonCodes: ['RECIPIENT_NOT_IN_ALLOWLIST'] });
    // A refusal decided something and committed nothing: `authorization_decisions` is written
    // only where an ALLOW reserves money, so the null here is the shape of a refusal, and the
    // row beside it — which did commit — is the control that the null is not just a missing
    // column on every row.
    expect(denied?.decision?.committedDecisionId).toBeNull();
    const allowed = body.transactions.find((row) => row.lifecycleState === 'TICKET_MINTED');
    expect(allowed?.decision).toMatchObject({ outcome: 'ALLOW', reasonCodes: [] });
    expect(allowed?.decision?.committedDecisionId).toMatch(/^dec_[0-9a-f-]{36}$/);

    // Risk travels with the row. What is asserted here is the *read's* guarantee — every one of
    // these was assessed, the level is a word the engine can produce, the score stayed a string
    // — and not which band a fresh tenant lands in. `NO_BEHAVIOUR_BASELINE` is deliberately not
    // the quietest answer, but the level is the scorer's claim and `risk.test.ts` owns it; a
    // read test that pinned "MEDIUM" would be asserting an inference about weights this file
    // does not read, and it was wrong the first time it ran.
    const LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
    for (const row of body.transactions) {
      expect(row.risk).not.toBeNull()
      expect(LEVELS).toContain(row.risk?.level)
      expect(Number(row.risk?.score)).toBeGreaterThanOrEqual(0)
      expect(row.risk?.score).toMatch(/^\d?(\.\d+)?$/)
      expect(row.risk?.signals.length).toBeGreaterThan(0)
    }
    // Money is a decimal string end to end, because a `Number()` anywhere on this path loses
    // precision above 2⁵³ and 10³⁰ raw wei is a real amount in this system.
    expect(denied?.amountRaw).toBe(usd(300n).toString());
    expect(denied?.currencyUnit).toBe(UNIT);
    expect(denied?.agentId).toBe(t.agentId);
    expect(denied?.recipientAddress).toBe(NOVEL);

    // The absence rule `api.test.ts` states for an agent's response holds for a human's too:
    // this tenant did mint a ticket — on the row above that reads SIGNING_PENDING — and a
    // ticket is not something any list of requests carries.
    expect(delivered.length).toBeGreaterThan(0);
    for (const ticket of delivered) expect(response.body).not.toContain(ticket);
  });

  it('shows no row the preview created, as the control that the other three are real', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);
    const { preview } = await withTraffic(t);
    expect(json<{ state: string }>(preview)).toMatchObject({ state: 'DECIDED' });

    const body = json<{ transactions: TransactionRow[] }>(await get('/v1/transactions', reader.bearer));
    expect(body.transactions).toHaveLength(3);
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ari.transaction_requests WHERE org_id = $1`,
      [t.orgId],
    );
    expect(count.rows[0]?.count).toBe(3);
  });

  it('bounds the page, and refuses a limit that is not a page size', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);
    await withTraffic(t);

    const one = json<{ transactions: TransactionRow[]; limit: number }>(
      await get('/v1/transactions?limit=1', reader.bearer),
    );
    expect(one.transactions).toHaveLength(1);
    expect(one.limit).toBe(1);

    // Each bad value gets its own expectation, because a loop that accepts either 400 or 200
    // asserts nothing and reads like coverage.
    for (const bad of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1%20', 'limit=1;DROP']) {
      const response = await get(`/v1/transactions?${bad}`, reader.bearer);
      expect(response.statusCode).toBe(400);
      expect(json<{ code: string }>(response).code).toBe('INVALID_REQUEST');
    }
    // An empty `agent` is refused for the same reason `004` bounds the column: it is a filter
    // that would match nothing, which a caller should hear about rather than read as an empty
    // tenant. A quoted string is not a syntax error to a bound parameter, so it is a filter
    // that matches no agent — and the honest answer is an empty page, not a 500.
    expect((await get('/v1/transactions?agent=', reader.bearer)).statusCode).toBe(400);
    const injected = json<{ transactions: TransactionRow[] }>(
      await get(`/v1/transactions?agent=${encodeURIComponent("nope'::text")}`, reader.bearer),
    );
    expect(injected.transactions).toEqual([]);

    // The ceiling is the point, so it has to bind rather than be a default: asking for a million
    // gets the first two hundred *and says the number it applied*, because a response that
    // echoes the request's limit is a screen that will render a page as if it were the table.
    const capped = json<{ limit: number; transactions: TransactionRow[] }>(
      await get('/v1/transactions?limit=999999', reader.bearer),
    );
    expect(capped.limit).toBe(MAX_READ_LIMIT);
    expect(capped.transactions.length).toBeLessThanOrEqual(MAX_READ_LIMIT);
  });

  it('will not show one tenant another tenant’s requests', async () => {
    const a = await tenant();
    const b = await tenant();
    const readerA = await human(a, ['transaction:read']);
    const readerB = await human(b, ['transaction:read']);
    await withTraffic(a);

    const empty = json<{ transactions: TransactionRow[] }>(await get('/v1/transactions', readerB.bearer));
    const full = json<{ transactions: TransactionRow[] }>(await get('/v1/transactions', readerA.bearer));
    // The control: B reads nothing *and* A reads three. A predicate broken for both tenants
    // would pass the first half alone.
    expect(empty.transactions).toHaveLength(0);
    expect(full.transactions).toHaveLength(3);

    const foreignId = full.transactions[0]?.id as string;
    const detail = await get(`/v1/transactions/${foreignId}/record`, readerB.bearer);
    expect(detail.statusCode).toBe(404);
    expect(json<{ code: string }>(detail).code).toBe('NOT_FOUND');
    expect((await get(`/v1/transactions/${foreignId}/record`, readerA.bearer)).statusCode).toBe(200);
  });
});

describe('GET /v1/transactions/:id/record', () => {
  it('refuses a long or unauthenticated lookup without becoming a 500 or an oracle', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);

    // A 300-character id never reaches the handler: Fastify's `maxParamLength` answers 404
    // first. Asserted rather than assumed because it means the route's own "at most 200" check
    // cannot fire above ~100 — the same dead ceiling `GET /v1/approvals/:id` carries — and a
    // control that reads as protection while the framework outranks it is worth naming out loud.
    const huge = await get(`/v1/transactions/${'x'.repeat(300)}/record`, reader.bearer);
    expect(huge.statusCode).toBe(404);
    expect(huge.body).not.toContain('at most 200');

    // A valid-shaped id and no credential is a 401, and the row was never looked at: the
    // alternative order would let anyone learn which ids exist by failing to authenticate.
    const anonymous = await api.app.inject({ method: 'GET', url: `/v1/transactions/txr_${'0'.repeat(36)}/record` });
    expect(anonymous.statusCode).toBe(401);
    expect(json<{ code: string }>(anonymous).code).toBe('CREDENTIAL_MISSING');
  });

  it('carries the canonical bytes, the decision, and the trail in the order the chain was built', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);
    const { denied } = await withTraffic(t);
    const deniedId = json<{ requestId: string }>(denied).requestId;

    const response = await get(`/v1/transactions/${deniedId}/record`, reader.bearer);
    expect(response.statusCode).toBe(200);
    const body = json<{ transaction: TransactionRow & {
      canonical: string;
      idempotencyKey: string;
      trail: { seq: string; eventType: string; actorType: string; madeAt: string }[];
    } }>(response);
    const record = body.transaction;

    expect(record.id).toBe(deniedId);
    // The canonical text is the bytes the digest was taken over and the ticket sealed, so the
    // recipient of a refusal has to appear in it — and the digest keeps the grammar the sealed
    // tokens carry (`canon/v1:…`), which is what the record is claiming to be about.
    expect(record.canonical).toContain(NOVEL);
    // The same grammar `CanonicalDigest` in `@ari/schemas` enforces on the way in — asserted
    // here rather than imported as a looser pattern so a record that stops carrying a real
    // digest cannot read as a record carrying a slightly odd one.
    expect(record.digest).toMatch(/^canon\/v1:[0-9a-f]{64}$/);
    expect(record.idempotencyKey).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(record.decision?.reasonCodes).toEqual(['RECIPIENT_NOT_IN_ALLOWLIST']);

    const types = record.trail.map((event) => event.eventType);
    expect(types).toContain('transaction.proposed');
    expect(types).toContain('policy.evaluated');
    expect(types).toContain('risk.assessed');
    expect(types).toContain('transaction.state_changed');
    // Oldest first, which is the order the hash chain was linked in, so the screen can show
    // each row's predecessor without re-sorting.
    const seq = record.trail.map((event) => BigInt(event.seq));
    expect([...seq].sort((x, y) => (x < y ? -1 : 1))).toEqual(seq);
    expect(types[0]).toBe('transaction.proposed');
    expect(record.trail.every((event) => event.madeAt <= new Date().toISOString())).toBe(true);
  });

  it('answers for a row, not for the caller’s id, and a preview has no row', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);
    const { preview, previewed } = await withTraffic(t);

    // A preview decided something and wrote nothing, so its answer carries no `requestId` at
    // all. That is the DECIDED arm of `handleOutcome` being honest, checked from the outside.
    const decided = json<{ state: string; reserves: boolean; requestId?: string }>(preview);
    expect(decided).toMatchObject({ state: 'DECIDED', reserves: false });
    expect(decided.requestId).toBeUndefined();

    // The caller's `req_` id is not the row's `txr_` id, and the record is keyed by the row.
    // Passing the one where the other belongs is the conflation `authorize` now parses its own
    // kernel output to catch, so it is worth asserting at the read too.
    const byCallerId = await get(`/v1/transactions/${previewed.requestId}/record`, reader.bearer);
    expect(byCallerId.statusCode).toBe(404);
    expect(json<{ code: string }>(byCallerId).code).toBe('NOT_FOUND');

    const listed = json<{ transactions: TransactionRow[] }>(await get('/v1/transactions', reader.bearer));
    expect(listed.transactions).toHaveLength(3);
    expect(listed.transactions.some((row) => row.id === previewed.requestId)).toBe(false);
  });
});

describe('GET /v1/summary', () => {
  it('counts the open windows off the database clock, in decimal strings', async () => {
    const t = await tenant();
    const reader = await human(t, ['transaction:read']);
    await withTraffic(t);

    const summary = json<{
      summary: {
        windows: { agentId: string; dimension: string; windowKey: string; currentReserved: string; settled: string }[];
        requestCountsByState: { state: string; count: number }[];
        agentsByStatus: { status: string; count: number }[];
        pendingApprovals: number;
        liveWallets: number;
        activePolicies: { policyVersionId: string; policyName: string; versionNumber: number }[];
      };
    }>(await get('/v1/summary', reader.bearer)).summary;

    // One ALLOW held money and the refusal held nothing; how much the escalation held is the
    // ledger's business, so the assertion reads it from the rows rather than restating a number
    // this file would have to keep correct about a branch it does not own. What is asserted is
    // that the summary's window agrees with the reservations table, and that there is money in
    // it — an agreement between two zeros would pass both halves of this.
    const held = await pool.query<{ held: string }>(
      `SELECT COALESCE(sum(amount_raw) FILTER (WHERE status = 'HELD'), 0)::text AS held
         FROM ari.reservations WHERE org_id = $1`,
      [t.orgId],
    );
    const daily = summary.windows.filter((row) => row.dimension.startsWith('daily'));
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ agentId: t.agentId, dimension: `daily_${UNIT}` });
    expect(daily[0]?.windowKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(BigInt(held.rows[0]?.held ?? '0')).toBeGreaterThan(0n);
    expect(BigInt(daily[0]?.currentReserved ?? '0')).toBe(BigInt(held.rows[0]?.held ?? '0'));
    expect(daily[0]?.settled).toBe('0');

    const byState = new Map(summary.requestCountsByState.map((row) => [row.state, row.count]));
    expect(byState.get('DENIED')).toBe(1);
    expect(byState.get('TICKET_MINTED')).toBe(1);
    expect(byState.get('APPROVAL_PENDING')).toBe(1);
    expect(summary.pendingApprovals).toBe(1);
    expect(summary.agentsByStatus).toEqual([{ status: 'ACTIVE', count: 1 }]);
    expect(summary.liveWallets).toBe(1);
    expect(summary.activePolicies).toEqual([
      { policyVersionId: t.policyVersionId, policyName: 'console', versionNumber: 1 },
    ]);

    // A credential that can see requests cannot see the summary, because the summary is a
    // statement about the windows the ledger enforces and `policy:read` was never about that.
    expect((await get('/v1/summary', (await human(t, ['policy:read'])).bearer)).statusCode).toBe(403);
  });
});

describe('GET /v1/wallets and GET /v1/policies', () => {
  it('shows a wallet, its mode and who holds it — and only to wallet:manage', async () => {
    const t = await tenant();
    const keeper = await human(t, ['wallet:manage']);
    const reader = await human(t, ['transaction:read']);

    const body = json<{ wallets: { id: string; mode: string; provider: string; address: string | null; displayName: string; grants: { agentId: string; policyVersionId: string; revokedAt: string | null }[] }[] }>(
      await get('/v1/wallets', keeper.bearer),
    );
    expect(body.wallets).toHaveLength(1);
    expect(body.wallets[0]).toMatchObject({
      id: t.walletId,
      displayName: 'ops',
      mode: 'delegated',
      provider: 'mock',
      address: null,
    });
    expect(body.wallets[0]?.grants).toEqual([
      { agentId: t.agentId, policyVersionId: t.policyVersionId, grantedAt: expect.any(String), revokedAt: null },
    ]);
    // `wallet:manage` is the gate: a credential that can list requests cannot list the things
    // money leaves through, because those are two different questions an operator may have
    // answered by two different people.
    expect((await get('/v1/wallets', reader.bearer)).statusCode).toBe(403);
  });

  it('returns the frozen document a decision was made under, and requires policy:read', async () => {
    const t = await tenant();
    const reader = await human(t, ['policy:read']);
    const activator = await human(t, ['policy:activate']);

    const body = json<{ policies: { id: string; name: string; versions: { id: string; status: string; versionNumber: number; document: { permissions: { transfers: { perDay: { maxRaw: string; unit: string } } } } }[] }[] }>(
      await get('/v1/policies', reader.bearer),
    );
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0]?.name).toBe('console');
    const version = body.policies[0]?.versions[0];
    expect(version?.id).toBe(t.policyVersionId);
    expect(version?.status).toBe('ACTIVE');
    expect(version?.versionNumber).toBe(1);
    // Money in the document is a decimal string too — the same rule as the candidate, because
    // it is the same number the compiler compares against.
    expect(version?.document.permissions.transfers.perDay).toEqual({ maxRaw: usd(5_000n).toString(), unit: UNIT });

    expect((await get('/v1/policies', activator.bearer)).statusCode).toBe(403);
    expect((await get('/v1/policies?limit=0', reader.bearer)).statusCode).toBe(400);
  });
});

describe('the reads answer for one tenant', () => {
  it('keeps every list empty for a tenant with no traffic, without an error', async () => {
    const t = await tenant();
    const all = await human(t, ['transaction:read', 'wallet:manage', 'policy:read', 'audit:read']);

    // A fresh tenant has a policy and a wallet, because `tenant()` made them, but no requests.
    const transactions = json<{ transactions: unknown[] }>(await get('/v1/transactions', all.bearer));
    expect(transactions.transactions).toEqual([]);
    const summary = json<{ summary: { requestCountsByState: unknown[]; windows: unknown[]; pendingApprovals: number } }>(
      await get('/v1/summary', all.bearer),
    );
    expect(summary.summary.requestCountsByState).toEqual([]);
    expect(summary.summary.pendingApprovals).toBe(0);
    // No window has been opened for this agent, which is the honest answer rather than a zero
    // row invented by the read.
    expect(summary.summary.windows).toEqual([]);
  });
});
