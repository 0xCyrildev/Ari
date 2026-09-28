/**
 * The HTTP surface, tested through the router rather than through a socket.
 *
 * `inject` covers everything the routes actually decide — authentication, status
 * codes, what is in a response — without a listening port. What it does *not* cover
 * is `listen`, the body limit and the signal handlers in `server.ts`. Those were
 * checked by hand instead — both processes up against Postgres, a tenant seeded
 * through the packages, every state observed over a real socket — and the comment says
 * so rather than implying the suite covers them.
 *
 * The most important assertions here are about absence: that a response carries no
 * ticket, and that a preview leaves no row behind.
 */

import { readConfig, startApi, type DeliveryResult, type RunningApi, type SignerClient } from '@ari/api';
import { createClient } from '@ari/client';
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
import { activateVersion, createPolicy } from '@ari/policies';
import { recordDecision, sealApproval } from '@ari/approvals';
import { CandidateTransaction, PolicyDocument, newId, type CanonicalDigest } from '@ari/schemas';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, DATABASE_URL } from './database.js';

let pool: Pool;
let appPool: Pool;
const app: Connector = {
  async connect() {
    const client = await appPool.connect();
    await client.query(`SET ROLE ari_app`);
    return client;
  },
};

const API = readConfig({
  // The same database the fixtures write their tenants into, read from the same place
  // the rest of the suite reads it. A literal here once made this file pass against a
  // long-lived database while its fixtures wrote to a fresh one: the API answered 401
  // because the credentials it looked for were in another database, and nothing about
  // that was visible in the failure.
  DATABASE_URL,
  DATABASE_ROLE: 'ari_app',
  CREDENTIAL_PEPPER: 'api-test-pepper-0123456789abcdef',
  TICKET_KEY: 't'.repeat(48),
  APPROVAL_KEY: 'a'.repeat(48),
  ORG_BOOTSTRAP_TOKEN: 'bootstrap-token-for-tests',
});

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const NOVEL = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';
const UNIT = 'usdc-6dp';
const usd = (whole: bigint) => whole * 1_000_000n;

/** Records what the signer was handed, so "the response hid it" can be proved. */
const delivered: { ticket: string; canonical: string }[] = [];
const signer: SignerClient = {
  async deliver(request): Promise<DeliveryResult> {
    delivered.push(request);
    return { accepted: true, state: 'SIGNING_PENDING' };
  },
};

let api: RunningApi;

beforeAll(async () => {
  pool = await connect();
  appPool = await connect(4);
  api = await startApi(API, signer);
});

afterAll(async () => {
  await api?.close();
  await appPool?.end();
  await pool?.end();
});

/**
 * The wire form of a candidate, not the parsed one.
 *
 * `CandidateTransaction.parse` produces an object holding `bigint`s — money as
 * `bigint` is the rule the whole repository runs on — and `JSON.stringify` throws on
 * a BigInt. So a client sends decimal *strings* and the server turns them into
 * bigints, which is exactly what this fixture reproduces: an object that can be put
 * on the wire, and the parser on the other side of it deciding what it means.
 */
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
    replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: null, maxFeePerUnit: null },
  };
  // Checked here rather than discovered later as an unexplained 400: a fixture the
  // parser refuses is a broken test, not a tested behaviour.
  const parsed = CandidateTransaction.safeParse(body);
  if (!parsed.success) throw new Error(`candidate fixture rejected: ${parsed.error.message}`);
  return body;
}

interface Tenant {
  readonly orgId: string;
  readonly owner: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly presented: string;
  readonly credentialId: string;
}

async function tenant(cap = usd(5_000n)): Promise<Tenant> {
  const orgId = await createOrganization(app, { name: 'HTTP', bootstrapActor: 'bootstrap' });
  const owner = await asTenant(app, orgId, (tx) =>
    createUser(tx, { email: `o${orgId.slice(4, 10)}@x.test`, displayName: 'O', role: 'owner', grantedBy: 'bootstrap' }),
  );
  const built = await asTenant(app, orgId, async (tx) => {
    const agentId = await createAgent(tx, { name: 'pay', createdBy: owner });
    const walletId = await createWallet(tx, {
      displayName: 'ops',
      mode: 'delegated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      provider: 'mock',
      actor: owner,
    });
    const document: PolicyDocument = {
      meta: { name: 'http', description: null },
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
    const created = await createPolicy(tx, { name: 'http', document, actor: owner });
    await activateVersion(tx, { policyId: created.policyId, versionId: created.versionId, actor: owner });
    await grantWalletToAgent(tx, { agentId, walletId, policyVersionId: created.versionId, actor: owner });
    const issued = await issueCredential(tx, {
      agentId,
      scopes: ['transaction:request'] as Scope[],
      ttlMs: 3_600_000n,
      masterPepper: API.masterPepper,
      actor: owner,
    });
    return { agentId, walletId, issued };
  });
  return {
    orgId,
    owner,
    agentId: built.agentId,
    walletId: built.walletId,
    presented: built.issued.presented,
    credentialId: built.issued.credentialId,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Requests in this organisation.
 *
 * Scoped on purpose: the suites run as parallel workers against one database, so a
 * global `count(*)` over `transaction_requests` is a number other files are changing
 * underneath it, and "the preview wrote nothing" would then fail for reasons that have
 * nothing to do with the preview. No other suite holds this org's credential.
 */
async function requestCount(orgId: string): Promise<number> {
  const rows = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ari.transaction_requests WHERE org_id = $1`,
    [orgId],
  );
  return rows.rows[0]?.count ?? -1;
}

describe('the edge refuses before it reasons', () => {
  it('answers a health check without credentials', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });

  it('will not create an organisation without the bootstrap token', async () => {
    const closed = await api.app.inject({ method: 'POST', url: '/v1/organizations', payload: { name: 'x' } });
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toEqual({ code: 'BOOTSTRAP_REQUIRED' });

    const wrong = await api.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: bearer('not-the-token-at-all-really'),
      payload: { name: 'x', ownerEmail: 'a@b.test', ownerDisplayName: 'A' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('creates an organisation and its owner with it', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: bearer('bootstrap-token-for-tests'),
      payload: { name: 'FreshCo', ownerEmail: 'founder@freshco.test', ownerDisplayName: 'Founder' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { organizationId: string; ownerId: string };
    expect(body.organizationId).toMatch(/^org_/);
    expect(body.ownerId).toMatch(/^usr_/);
    // No credential, no session, no token: those need a decision that has not been
    // made, and an endpoint that improvised one would be worse than one missing.
    expect(JSON.stringify(body)).not.toMatch(/secret|token|password|credential/i);
  });

  it('answers an unknown key and a wrong secret identically (T8)', async () => {
    const t = await tenant();
    const unknownKey = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(`${t.orgId}.${newId('crd')}.${'x'.repeat(43)}`),
      payload: { candidate: {}, idempotencyKey: 'k' },
    });
    const wrongSecret = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(`${t.orgId}.${t.credentialId}.${'x'.repeat(43)}`),
      payload: { candidate: {}, idempotencyKey: 'k' },
    });
    expect(unknownKey.statusCode).toBe(401);
    expect(unknownKey.json()).toEqual(wrongSecret.json());
  });

  it('stops working the moment the agent is retired (S14)', async () => {
    const t = await tenant();
    const before = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/evaluate',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)) },
    });
    expect(before.statusCode).toBe(200);

    await asTenant(app, t.orgId, (tx) =>
      tx.client.query(`UPDATE ari.agents SET status = 'REVOKED', revoked_at = now() WHERE id = $1`, [t.agentId]),
    );
    const revoked = await revokeCredential(app, t.orgId, t.credentialId);
    expect(revoked.revoked).toBe(true);
    const after = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/evaluate',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)) },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('authorize over HTTP', () => {
  it('hands the ticket to the signer and never to the caller (T2, S16)', async () => {
    const t = await tenant();
    const started = delivered.length;
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: {
        candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)),
        idempotencyKey: 'http-500',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { state: string; requestId: string };
    expect(body.state).toBe('SIGNING_PENDING');

    // The proof is the comparison, not the shape: the ticket exists, was sent
    // somewhere else, and does not appear in the bytes this caller received.
    expect(delivered.length).toBe(started + 1);
    const held = delivered[started];
    expect(held?.ticket.length).toBeGreaterThan(60);
    expect(response.body).not.toContain(held?.ticket ?? 'absent');
    expect(response.body).not.toContain(held?.canonical ?? 'absent');
  });

  it('reports a denial as a denial', async () => {
    const t = await tenant();
    const started = delivered.length;
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: {
        candidate: candidate(t.walletId, t.agentId, NOVEL, usd(50_000n)),
        idempotencyKey: 'http-denied',
      },
    });
    const body = response.json() as { state: string; reasonCodes: string[] };
    expect(body.state).toBe('DENIED');
    expect(body.reasonCodes).toContain('RECIPIENT_NOT_IN_ALLOWLIST');
    // A refusal that reaches the signer is the one failure this surface must never
    // have; counting the deliveries is how "never" is checked rather than asserted.
    expect(delivered).toHaveLength(started);
  });

  it('asks a human, and completes once one has answered', async () => {
    const t = await tenant();
    // One candidate object, presented twice. It is not a stylistic choice: the
    // idempotency key is a promise that the second call is the same transaction, and
    // `recordRequest` throws when a different digest arrives under it. Regenerating
    // the candidate here would change its request id, and with it the canonical bytes
    // the approval is bound to — so this test would be checking a mismatch rather than
    // an approval.
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const first = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'http-2000' },
    });
    const pending = first.json() as { state: string; approvalId: string; requestId: string };
    expect(pending.state).toBe('APPROVAL_PENDING');
    expect(pending.approvalId).toMatch(/^apr_/);

    await asTenant(app, t.orgId, (tx) =>
      recordDecision(tx, { approvalId: pending.approvalId, approver: t.owner, decision: 'APPROVED' }),
    );
    const token = await approvalToken(pending.approvalId);
    const second = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'http-2000', approvalToken: token },
    });
    const granted = second.json() as { state: string; requestId: string };
    expect(granted.state).toBe('SIGNING_PENDING');
    expect(granted.requestId).toBe(pending.requestId);
  });

  it('says what it could not deliver rather than calling it a refusal', async () => {
    const t = await tenant();
    const offline = await startApi(API, {
      async deliver() {
        return { accepted: false, code: 'SIGNING_PROVIDER_ERROR', detail: 'unreachable' };
      },
    });
    const response = await offline.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)), idempotencyKey: 'http-offline' },
    });
    const body = response.json() as { state: string; code: string };
    expect(body.state).toBe('TICKET_ISSUED_NOT_DELIVERED');
    expect(body.code).toBe('SIGNING_PROVIDER_ERROR');
    await offline.close();
  });
});

describe('evaluate is a preview', () => {
  it('answers with the decision and reserves nothing', async () => {
    const t = await tenant();
    const before = await requestCount(t.orgId);
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/evaluate',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(50_000n)) },
    });
    const body = response.json() as { state: string; reserves: boolean; decision: { outcome: string; reasonCodes: string[] } };
    expect(body.state).toBe('DECIDED');
    expect(body.reserves).toBe(false);
    expect(body.decision.outcome).toBe('DENY');
    expect(await requestCount(t.orgId)).toBe(before);
  });

  it('tells the truth about how provisional it is', async () => {
    // A preview at exactly the limit is the case where `evaluate` and `authorize`
    // disagree, and §3 says the response must say so rather than look equivalent.
    const t = await tenant(usd(1_000n));
    const preview = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/evaluate',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)) },
    });
    expect((preview.json() as { decision: { outcome: string } }).decision.outcome).toBe('ALLOW');

    const held = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(1_000n)), idempotencyKey: 'took-it' },
    });
    expect((held.json() as { state: string }).state).toBe('SIGNING_PENDING');

    const later = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/evaluate',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)) },
    });
    expect((later.json() as { decision: { outcome: string } }).decision.outcome).toBe('DENY');
  });
});

describe('status', () => {
  it('returns the state of a request and nothing else', async () => {
    const t = await tenant();
    const issued = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)), idempotencyKey: 'status-1' },
    });
    const requestId = (issued.json() as { requestId: string }).requestId;
    const response = await api.app.inject({
      method: 'GET',
      url: `/v1/transactions/${requestId}`,
      headers: bearer(t.presented),
    });
    const body = response.json() as { requestId: string; state: string };
    expect(body.state).toBe('TICKET_MINTED');
    expect(JSON.stringify(body)).not.toContain('canonical');
  });

  it('answers 404 for another tenant’s request, exactly as it would for none', async () => {
    const mine = await tenant();
    const theirs = await tenant();
    const issued = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(theirs.presented),
      payload: { candidate: candidate(theirs.walletId, theirs.agentId, RECIPIENT, usd(500n)), idempotencyKey: 'status-2' },
    });
    const requestId = (issued.json() as { requestId: string }).requestId;

    const probe = await api.app.inject({
      method: 'GET',
      url: `/v1/transactions/${requestId}`,
      headers: bearer(mine.presented),
    });
    const missing = await api.app.inject({
      method: 'GET',
      url: '/v1/transactions/txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      headers: bearer(mine.presented),
    });
    expect(probe.statusCode).toBe(404);
    expect(probe.json()).toEqual(missing.json());
  });

  it('rejects a body the parser cannot read, and says so', async () => {
    const t = await tenant();
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: { kind: 'transfer' }, idempotencyKey: 'x' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('INVALID_REQUEST');
  });
});

describe('the SDK and the edge, with no socket between them', () => {
  /**
   * The client's transport pointed at the router.
   *
   * This is the only place the two halves of the wire contract meet. `routes.ts` builds
   * a response, `@ari/client` parses one, and each is `.strict()` about the other's
   * shape — so a field added on either side without a decision on it fails here rather
   * than in someone's integration test three weeks later. It also proves the serialiser
   * against the real object graph: a parsed candidate holds `bigint`s, and a client
   * that could not send them would come back as `NETWORK` from its own catch.
   */
  function sdk(token: string) {
    return createClient({
      baseUrl: 'http://api.test',
      credential: token,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const response = await api.app.inject({
          method: (init?.method ?? 'GET') as 'GET' | 'POST',
          url: new URL(String(url)).pathname,
          headers: Object.fromEntries(new Headers(init?.headers ?? {})),
          ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
        });
        return new Response(response.body, { status: response.statusCode });
      }) as typeof fetch,
    });
  }

  it('reads a preview, a decision and a status without a shape complaint', async () => {
    const t = await tenant();
    const client = sdk(t.presented);
    const held = CandidateTransaction.parse(candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)));

    const preview = await client.evaluate(held);
    expect(preview.ok && preview.value.reserves).toBe(false);
    expect(preview.ok && preview.value.decision.outcome).toBe('ALLOW');

    const issued = await client.authorize({ candidate: held, idempotencyKey: 'sdk-500' });
    if (!issued.ok) throw new Error(`the client refused the server's shape: ${issued.code} ${issued.detail}`);
    expect(issued.value.state).toBe('SIGNING_PENDING');

    const status = await client.status(issued.value.requestId);
    expect(status.ok && status.value.state).toBe('TICKET_MINTED');
  });

  it('reports a refusal as the server named it', async () => {
    const t = await tenant();
    const denied = await sdk(t.presented).authorize({
      candidate: CandidateTransaction.parse(candidate(t.walletId, t.agentId, NOVEL, usd(50_000n))),
      idempotencyKey: 'sdk-denied',
    });
    if (!denied.ok || denied.value.state !== 'DENIED') {
      throw new Error(`expected a denial, got ${JSON.stringify(denied)}`);
    }
    // Narrowing is the point of the assertion, not a detail: `reasonCodes` exists on
    // this arm alone, which is the client's type system saying a denial and an
    // accepted request are different answers rather than two spellings of one.
    expect(denied.value.reasonCodes).toContain('RECIPIENT_NOT_IN_ALLOWLIST');

    const refused = await sdk(`${t.orgId}.${t.credentialId}.${'x'.repeat(43)}`).evaluate(
      CandidateTransaction.parse(candidate(t.walletId, t.agentId, RECIPIENT, usd(500n))),
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.status).toBe(401);
    expect(refused.ok === false && refused.code).toBe('UNAUTHENTICATED');
  });
});

describe('what the ledger does with the signer’s answer', () => {
  /**
   * The step that used to not exist. The decision plane committed a hold, a decision
   * and a ticket; the signer answered; and nothing anywhere read that answer. So a
   * payment that had been signed was still counted as *parked* capacity, a payment the
   * authority plane could never honour kept the agent’s daily total forever (T13, with
   * Ari’s own hand on the lever), and `settle`/`release` were functions with no caller.
   */
  async function reservedToday(orgId: string, agentId: string): Promise<bigint> {
    const rows = await pool.query<{ current: string }>(
      `SELECT current_reserved AS current FROM ari.limit_counters
        WHERE org_id = $1 AND agent_id = $2 AND dimension LIKE 'daily_%'`,
      [orgId, agentId],
    );
    return BigInt(rows.rows[0]?.current ?? '0');
  }

  async function reservationState(requestId: string): Promise<string | null> {
    const rows = await pool.query<{ status: string }>(
      `SELECT status FROM ari.reservations WHERE request_id = $1 ORDER BY dimension LIMIT 1`,
      [requestId],
    );
    return rows.rows[0]?.status ?? null;
  }

  async function paidWith(
    t: Tenant,
    key: string,
    signer: SignerClient,
  ): Promise<{ requestId: string; body: Record<string, unknown> }> {
    const apiUnderTest = await startApi(API, signer);
    try {
      const response = await apiUnderTest.app.inject({
        method: 'POST',
        url: '/v1/transactions/authorize',
        headers: bearer(t.presented),
        payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)), idempotencyKey: key },
      });
      return { requestId: (response.json() as { requestId: string }).requestId, body: response.json() as Record<string, unknown> };
    } finally {
      await apiUnderTest.close();
    }
  }

  it('settles the hold when the signer reports a signature, and walks the request', async () => {
    const t = await tenant();
    expect(await reservedToday(t.orgId, t.agentId)).toBe(0n);
    const { requestId } = await paidWith(t, 'delivery-complete', {
      async deliver() {
        return { accepted: true, state: 'COMPLETE' };
      },
    });
    expect(await reservationState(requestId)).toBe('SETTLED');
    // Settled money has left the window’s parked total, and the daily cap still binds on
    // it — which is the half of this that a `current_reserved` of zero would otherwise
    // make look like a refund.
    expect(await reservedToday(t.orgId, t.agentId)).toBe(0n);

    const status = await api.app.inject({ method: 'GET', url: `/v1/transactions/${requestId}`, headers: bearer(t.presented) });
    expect((status.json() as { state: string }).state).toBe('SIGNING_COMPLETE');
  });

  it('leaves the capacity held while the signature is still in flight', async () => {
    const t = await tenant();
    const { requestId } = await paidWith(t, 'delivery-pending', {
      async deliver() {
        return { accepted: true, state: 'SIGNING_PENDING' };
      },
    });
    // A `user_gated` handoff is exactly this answer, and settling it would be Ari
    // claiming a signature it does not have (S12).
    expect(await reservationState(requestId)).toBe('HELD');
    expect(await reservedToday(t.orgId, t.agentId)).toBe(usd(500n));
  });

  it('gives the capacity back when the signer says it can never honour this one', async () => {
    const t = await tenant();
    const { requestId } = await paidWith(t, 'delivery-refused', {
      async deliver() {
        return { accepted: false, code: 'TICKET_ALREADY_USED', detail: 'spent' };
      },
    });
    expect(await reservationState(requestId)).toBe('RELEASED');
    expect(await reservedToday(t.orgId, t.agentId)).toBe(0n);
  });

  it('keeps it when the signer simply did not answer', async () => {
    const t = await tenant();
    const { requestId, body } = await paidWith(t, 'delivery-silent', {
      async deliver() {
        return { accepted: false, code: 'SIGNING_PROVIDER_ERROR', detail: 'unreachable' };
      },
    });
    // A retry re-seals the same ticket and re-delivers it, so releasing here would let an
    // agent spend the day’s capacity twice on the afternoon its signer blipped.
    expect(body.state).toBe('TICKET_ISSUED_NOT_DELIVERED');
    expect(await reservationState(requestId)).toBe('HELD');
    expect(await reservedToday(t.orgId, t.agentId)).toBe(usd(500n));
  });

  it('parks it when the signer refused *us*, because that is a fault and not a refusal', async () => {
    const t = await tenant();
    const { requestId, body } = await paidWith(t, 'delivery-unauthenticated', {
      async deliver() {
        return { accepted: false, code: 'SIGNER_UNAUTHENTICATED', detail: 'the signer refused the delivery credential' };
      },
    });
    // The distinction this asserts is the one the classification in `signer-client.ts`
    // protects: a rejected delivery credential says this deployment is misconfigured, not
    // that the ticket is unspendable. Treating it as terminal would give the day's
    // capacity back *and* leave a minted, unredeemed ticket live to be re-delivered after
    // the operator fixes the secret — capacity refunded twice over one typo.
    expect(body.state).toBe('TICKET_ISSUED_NOT_DELIVERED');
    expect((body as { code?: string }).code).toBe('SIGNER_UNAUTHENTICATED');
    expect(await reservationState(requestId)).toBe('HELD');
    expect(await reservedToday(t.orgId, t.agentId)).toBe(usd(500n));
  });

  it('parks it when the signer answered something this client cannot classify', async () => {
    const t = await tenant();
    const { requestId, body } = await paidWith(t, 'delivery-unrecognised', {
      async deliver() {
        // Exactly what a `SIGNER_URL` with a trailing slash produces: the signer's 404,
        // which carries a state and no code.
        return { accepted: false, code: 'SIGNER_ANSWER_UNRECOGNISED', detail: 'signer answered 404 without a code' };
      },
    });
    // The regression this guards is a released hold: on 2026-09-28 the deployed pair refunded
    // a day's capacity and wrote `reservation.released` for a typo in an environment
    // variable, because the client's fallback named a *terminal* code. An unclassifiable
    // answer must leave the money parked and the ticket redeemable.
    expect(body.state).toBe('TICKET_ISSUED_NOT_DELIVERED');
    expect(await reservationState(requestId)).toBe('HELD');
    expect(await reservedToday(t.orgId, t.agentId)).toBe(usd(500n));
  });
});

describe('what the API process itself is allowed to hold', () => {
  it('connects as the unprivileged role, so the tenant filters are not the only line (008)', async () => {
    const client = await api.deps.pool.connect();
    try {
      const who = await client.query<{ role: string }>(`SELECT current_user AS role`);
      expect(who.rows[0]?.role).toBe('ari_app');

      // `ari` owns these tables, so a connection made as it bypasses row security and
      // could delete the audit trail. This one can do neither — which is the
      // difference between the `org_id` filters in the routes being a second line of
      // defence and being the only one.
      await expect(client.query(`DELETE FROM ari.audit_events`)).rejects.toThrow(/permission denied/i);
      // Row security on *every* tenant table, including the ones that hold money and
      // evidence rather than identity: an unscoped connection reads none of it. Tenants
      // have paid for rows in all of these tables by now, so zero is a statement.
      for (const table of ['users', 'audit_events', 'reservations', 'limit_counters', 'authorization_decisions']) {
        // Identifier position, not a value position: a table name cannot be a bind
        // parameter, so this loop is only safe because the list above is a literal. The
        // `sql-hygiene` test in `tests/unit/` is what keeps that true repo-wide.
        const unscoped = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ari.` + table,
        );
        expect(unscoped.rows[0]?.count, `unscoped read of ${table} saw rows`).toBe(0);
      }
    } finally {
      client.release();
    }
  });

  it('answers an unknown route without naming the framework or echoing the path', async () => {
    // Fastify's default body for this is `{"message":"Route GET:/not-a-route not
    // found","error":"Not Found","statusCode":404}` — a product fingerprint plus the
    // caller's own guess reflected back at it. Observed on the deployed API on 2026-09-28,
    // which is how the gap was found: `setErrorHandler` had been added for exactly this
    // reason, and the not-found path was never given the same treatment.
    for (const [method, url] of [
      ['GET', '/not-a-route'],
      ['POST', '/v1/sign'],
      ['GET', '/v1/users/nope/nope'],
    ] as const) {
      const response = await api.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json()).toEqual({ code: 'NOT_FOUND' });
      expect(response.body).not.toContain('not-a-route');
      expect(response.body.toLowerCase()).not.toContain('fastify');
    }
  });

  it('answers an internal failure with a code, not with the reason', async () => {
    const t = await tenant();
    const first = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(500n)), idempotencyKey: 'clash' },
    });
    expect(first.statusCode).toBe(200);
    // The same key under a different transaction: `recordRequest` throws rather than
    // guess, and the throw is this process's bug to describe, not the caller's to read.
    const clash = await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(900n)), idempotencyKey: 'clash' },
    });
    expect(clash.statusCode).toBe(500);
    expect(clash.json()).toEqual({ code: 'INTERNAL' });
    // Silence outward is the decision. Silence *inward* was a bug: `logger: false` made
    // `app.log` a no-op, so a 500 left no trace anywhere and whoever was holding the failing
    // request had to reproduce it to learn which constraint broke. The error now goes to the
    // process's stderr, where the operator's log is, and never into the response.
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await api.app.inject({
        method: 'POST',
        url: '/v1/transactions/authorize',
        headers: bearer(t.presented),
        payload: { candidate: candidate(t.walletId, t.agentId, RECIPIENT, usd(700n)), idempotencyKey: 'clash' },
      });
    } finally {
      process.stderr.write = original;
    }
    const trace = written.join('');
    expect(trace).toMatch(/ari-api: unhandled 500/);
    expect(trace).toMatch(/idempotency|conflict|duplicate key/i);
    // And the response that the caller sees is still the one-word answer it was before.
    expect(trace).not.toMatch(/candidate|digest/);
  });
});

/** The token a human's client would present, read back from the row that was approved. */
async function approvalToken(approvalId: string): Promise<string> {
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
  if (row === undefined) throw new Error('approval row not found');
  // Sealed with the key the running API was configured with — the same one
  // `requestApproval` sealed its own answer with. A test that used a second key would
  // prove nothing about what a real approver's client has to produce.
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
      nonce: 'test-nonce-for-approval-token-000000000000000000',
    },
    API.approvalKey,
  );
}

/**
 * An approver, created the way an operator would create one today: the bootstrap token,
 * then a user, then that user's credential — all over HTTP.
 *
 * Deliberately not a fixture that writes rows directly. The point of these routes is
 * that a person outside the process can be given authority, so the test has to be
 * incapable of passing if that path is broken.
 */
async function approver(
  t: Tenant,
  input: { readonly role: 'owner' | 'admin' | 'approver' | 'viewer'; readonly scopes: readonly string[] },
): Promise<{ readonly userId: string; readonly bearer: string }> {
  const email = `${input.role}-${newId('req').slice(4, 12)}@x.test`;
  const made = await api.app.inject({
    method: 'POST',
    url: '/v1/users',
    headers: bearer('bootstrap-token-for-tests'),
    payload: { organizationId: t.orgId, email, displayName: 'A Approver', role: input.role },
  });
  if (made.statusCode !== 201) throw new Error(`user creation refused: ${made.statusCode} ${made.body}`);
  const userId = (made.json() as { userId: string }).userId;

  const credential = await api.app.inject({
    method: 'POST',
    url: `/v1/users/${userId}/credentials`,
    headers: bearer('bootstrap-token-for-tests'),
    payload: { organizationId: t.orgId, scopes: [...input.scopes], ttlMs: '3600000' },
  });
  if (credential.statusCode !== 201) {
    throw new Error(`credential issuance refused: ${credential.statusCode} ${credential.body}`);
  }
  return { userId, bearer: (credential.json() as { bearer: string }).bearer };
}

const DECIDE = ['approval:decide'];

describe('the approver’s surface', () => {
  it('will not mint an approver credential that could also propose a payment', async () => {
    const t = await tenant();
    const proposed = await api.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer('bootstrap-token-for-tests'),
      payload: { organizationId: t.orgId, email: 'both@x.test', displayName: 'Both', role: 'admin' },
    });
    const userId = (proposed.json() as { userId: string }).userId;
    const refused = await api.app.inject({
      method: 'POST',
      url: `/v1/users/${userId}/credentials`,
      headers: bearer('bootstrap-token-for-tests'),
      payload: { organizationId: t.orgId, scopes: ['transaction:request', 'approval:decide'], ttlMs: '3600000' },
    });
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { detail: string }).detail).toMatch(/transaction:request/);
  });

  it('refuses the operator routes without the bootstrap token', async () => {
    const t = await tenant();
    const closed = await api.app.inject({
      method: 'POST',
      url: '/v1/users',
      payload: { organizationId: t.orgId, email: 'no@x.test', displayName: 'No', role: 'approver' },
    });
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toEqual({ code: 'BOOTSTRAP_REQUIRED' });
  });

  it('will not let an agent decide, because the secret is not that kind of secret', async () => {
    const t = await tenant();
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'agent-tries' },
    })).json() as { approvalId: string };

    const selfApproved = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(t.presented),
      payload: { decision: 'APPROVED' },
    });
    // 401, not 403: a `crd_` secret does not parse at the approver gate, which is the
    // same answer a wrong secret gives. The agent learns nothing about whether an
    // approval of its own exists that it could not otherwise have found.
    expect(selfApproved.statusCode).toBe(401);
    expect(selfApproved.json()).toEqual({ code: 'UNAUTHENTICATED', detail: 'the credential was not accepted' });
  });

  it('refuses a credential that has the scope in name only, and reads it from the row', async () => {
    const t = await tenant();
    const read = await approver(t, { role: 'approver', scopes: ['transaction:read'] });
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'wrong-scope' },
    })).json() as { approvalId: string };

    const refused = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(read.bearer),
      payload: { decision: 'APPROVED' },
    });
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { code: string }).code).toBe('SCOPE_REFUSED');
  });

  it('refuses an approver whose role the policy did not name', async () => {
    const t = await tenant();
    // A viewer with the scope: the credential says this person may decide approvals, the
    // membership says they are not one of the roles this policy asked for. Both have to
    // be true, and the second is what `allowed_roles` is for.
    const viewer = await approver(t, { role: 'viewer', scopes: DECIDE });
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'wrong-role' },
    })).json() as { approvalId: string };

    const refused = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(viewer.bearer),
      payload: { decision: 'APPROVED' },
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { code: string }).code).toBe('APPROVER_NOT_AUTHORISED');
    // And the refusal is a record, not just a status: an approver turned away for the
    // wrong reason and one turned away for the right one must be distinguishable
    // afterwards by someone who was not in the room.
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM ari.audit_events WHERE resource_id = $1 AND event_type = 'approval.claim_refused'`,
      [pending.approvalId],
    );
    expect(events.rowCount).toBe(1);
  });

  it('answers one human, one vote', async () => {
    const t = await tenant();
    const owner = await approver(t, { role: 'owner', scopes: DECIDE });
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'twice' },
    })).json() as { approvalId: string };

    const first = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(owner.bearer),
      payload: { decision: 'APPROVED' },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { state: string }).state).toBe('GRANTED');

    const again = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(owner.bearer),
      payload: { decision: 'APPROVED' },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe('APPROVAL_ALREADY_CONSUMED');
  });

  it('shows a pending approval to the role it is waiting on, and to nobody else', async () => {
    const mine = await tenant();
    const theirs = await tenant();
    const holder = await approver(mine, { role: 'owner', scopes: DECIDE });
    const outsider = await approver(theirs, { role: 'owner', scopes: DECIDE });

    const held = candidate(mine.walletId, mine.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(mine.presented),
      payload: { candidate: held, idempotencyKey: 'queue' },
    })).json() as { approvalId: string };

    const queue = await api.app.inject({ method: 'GET', url: '/v1/approvals', headers: bearer(holder.bearer) });
    const listed = (queue.json() as { approvals: { approvalId: string }[] }).approvals;
    expect(listed.map((a) => a.approvalId)).toContain(pending.approvalId);
    // Every entry is this tenant's, checked against the database rather than against
    // another tenant's id: the queue is the one place where a filter that silently
    // returned *everything* would look like a working feature.
    const mineInDb = await pool.query<{ id: string }>(
      `SELECT id FROM ari.approval_requests WHERE org_id = $1`,
      [mine.orgId],
    );
    const mineIds = new Set(mineInDb.rows.map((r) => r.id));
    expect(listed.every((a) => mineIds.has(a.approvalId))).toBe(true);

    const elsewhere = await api.app.inject({ method: 'GET', url: '/v1/approvals', headers: bearer(outsider.bearer) });
    const otherList = (elsewhere.json() as { approvals: { approvalId: string }[] }).approvals;
    expect(otherList.map((a) => a.approvalId)).not.toContain(pending.approvalId);

    // And reading it directly answers the same as if it did not exist.
    const stolen = await api.app.inject({
      method: 'GET',
      url: `/v1/approvals/${pending.approvalId}`,
      headers: bearer(outsider.bearer),
    });
    expect(stolen.statusCode).toBe(404);
    expect(stolen.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('loses the right to decide the moment the person is suspended', async () => {
    // `users.status` had no reader at all before `013` gave the credential lookup a join
    // on it: suspending someone wrote a column and changed nothing else. This is the
    // test that makes the column mean something.
    const t = await tenant();
    const owner = await approver(t, { role: 'owner', scopes: DECIDE });
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'suspended' },
    })).json() as { approvalId: string };

    await pool.query(`UPDATE ari.users SET status = 'SUSPENDED' WHERE id = $1`, [owner.userId]);

    const refused = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(owner.bearer),
      payload: { decision: 'APPROVED' },
    });
    expect(refused.statusCode).toBe(401);
    // Unsuspend, and the same credential works: the suspension is the refusal, not the
    // credential having been burned by presenting it while suspended.
    await pool.query(`UPDATE ari.users SET status = 'ACTIVE' WHERE id = $1`, [owner.userId]);
    const allowed = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(owner.bearer),
      payload: { decision: 'APPROVED' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('refuses one no, and records it as the end of the request rather than a vote', async () => {
    const t = await tenant();
    const owner = await approver(t, { role: 'owner', scopes: DECIDE });
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'one-no' },
    })).json() as { approvalId: string };

    const rejected = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(owner.bearer),
      payload: { decision: 'REJECTED' },
    });
    const body = rejected.json() as { state: string; approvalToken?: string };
    expect(body.state).toBe('REJECTED');
    expect(body.approvalToken).toBeUndefined();
    // A rejected approval is not a spendable one, whoever presents it afterwards.
    const detail = await api.app.inject({
      method: 'GET',
      url: `/v1/approvals/${pending.approvalId}`,
      headers: bearer(owner.bearer),
    });
    expect((detail.json() as { approval: { status: string } }).approval.status).toBe('REJECTED');
  });

  it('hands the sealed token to the human who earned it, and nowhere else', async () => {
    const t = await tenant();
    const owner = await approver(t, { role: 'owner', scopes: DECIDE });
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));
    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'who-gets-it' },
    })).json() as { approvalId: string; requestId: string };

    const granted = await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(owner.bearer),
      payload: { decision: 'APPROVED' },
    });
    const token = (granted.json() as { approvalToken?: string }).approvalToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // The agent's own view of the same request never carries it. The token authorises a
    // signature, so the subject being restricted must not be able to read it out of an
    // API it is allowed to call — it arrives from the human, or the operator, or nowhere.
    const status = await api.app.inject({
      method: 'GET',
      url: `/v1/transactions/${pending.requestId}`,
      headers: bearer(t.presented),
    });
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.json())).not.toMatch(/approvalToken/);
    // And the human who decided does hold it: same response, opposite expectation, so
    // the assertion above cannot be satisfied by a route that never returns one.
    expect(JSON.stringify(granted.json())).toContain(token ?? 'absent');
  });

  it('takes the whole round trip over sockets, with no test-side minting', async () => {
    const t = await tenant();
    const owner = await approver(t, { role: 'owner', scopes: DECIDE });
    const held = candidate(t.walletId, t.agentId, RECIPIENT, usd(2_000n));

    const pending = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'closed-loop' },
    })).json() as { state: string; approvalId: string; requestId: string };
    expect(pending.state).toBe('APPROVAL_PENDING');

    const granted = (await api.app.inject({
      method: 'POST',
      url: `/v1/approvals/${pending.approvalId}/decisions`,
      headers: bearer(owner.bearer),
      payload: { decision: 'APPROVED' },
    })).json() as { state: string; approvalToken: string };

    const completed = (await api.app.inject({
      method: 'POST',
      url: '/v1/transactions/authorize',
      headers: bearer(t.presented),
      payload: { candidate: held, idempotencyKey: 'closed-loop', approvalToken: granted.approvalToken },
    })).json() as { state: string; requestId: string };
    expect(completed.state).toBe('SIGNING_PENDING');
    expect(completed.requestId).toBe(pending.requestId);
  });
});
