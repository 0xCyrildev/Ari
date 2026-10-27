/**
 * Identity, credentials and the tenant boundary (Phase 1 gate).
 *
 * The gate asks for an IDOR suite "across every resource" and for revoked/expired
 * credentials to answer with distinct reason codes. Both are tested against
 * Postgres, and the IDOR half is tested harder than the repository layer needs:
 * the tenant-bearing checks run on a connection that has assumed the application
 * role, so a pass means row security held — not merely that a function remembered
 * its `orgId` argument.
 */

import { newId } from '@ari/schemas';
import { readEventLog, verifyChain } from '@ari/audit';
import {
  asTenant,
  changeUserRole,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  grantWalletToAgent,
  activeScopes,
  issueCredential,
  listCredentials,
  parsePresented,
  pepperFor,
  recordRequest,
  recipientFirstSeenAt,
  revokeCredential,
  rotateCredential,
  setAgentStatus,
  setRequestState,
  verifyCredential,
  type Connector,
  type Scope,
} from '@ari/identity';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, DATABASE_URL } from './database.js';

const PEPPER = 'test-master-pepper-0123456789abcdef';
const SCOPES: readonly Scope[] = ['transaction:request'];
const TTL = 3_600_000n;

let pool: Pool;
/**
 * A pool whose connections are all `ari_app`, used only through `asApp()`.
 *
 * No `RESET ROLE` on release, deliberately: a reset that has not finished before
 * the client goes back is worse than no reset, because it reads as cleanup. The
 * guarantee is structural instead — this pool is never handed to anything that
 * expects the owner's rights, and every connection assumes the role the moment it
 * is taken.
 */
let appPool: Pool;
const app: Connector = {
  async connect(): Promise<PoolClient> {
    const client = await appPool.connect();
    await client.query(`SET ROLE ari_app`);
    return client;
  },
};

beforeAll(async () => {
  const shared = await connect();
  pool = shared;
  appPool = new Pool({
    connectionString: DATABASE_URL,
    max: 4,
  });
});

afterAll(async () => {
  await appPool?.end();
  await pool?.end();
});

async function tenant(): Promise<string> {
  return createOrganization(app, { name: 'Test Org', bootstrapActor: 'system' });
}

/**
 * A live credential, optionally for an agent that already exists.
 *
 * The optional agent matters more than it looks: a test that pauses one agent and
 * then authenticates a credential belonging to whichever agent the helper happened
 * to create will pass for the wrong reason, or fail for one.
 */
async function setup(orgId: string, forAgent?: string) {
  return asTenant(app, orgId, async (tx) => {
    const agentId = forAgent ?? (await createAgent(tx, { name: 'payer', createdBy: 'tester' }));
    const issued = await issueCredential(tx, {
      agentId,
      scopes: SCOPES,
      ttlMs: TTL,
      masterPepper: PEPPER,
      actor: 'tester',
    });
    return { agentId, issued };
  });
}

function storedRow(credentialId: string) {
  return pool.query<{ secret_hash: string; scopes: string[]; key_id: string }>(
    `SELECT secret_hash, scopes, key_id FROM ari.agent_credentials WHERE id = $1`,
    [credentialId],
  );
}

describe('credentials', () => {
  it('issues, presents and verifies — and stores a hash, never the secret', async () => {
    const orgId = await tenant();
    const { agentId, issued } = await setup(orgId);
    const stored = (await storedRow(issued.credentialId)).rows[0];

    expect(stored?.secret_hash).toContain('$argon2id$');
    expect(stored?.secret_hash).not.toContain(issued.presented);
    expect(stored?.secret_hash).not.toContain(issued.presented.split('.')[2] ?? 'absent');

    const verified = await verifyCredential(app, issued.presented, PEPPER);
    expect(verified).toMatchObject({ ok: true, orgId, agentId });
    if (!verified.ok) return;
    expect(verified.scopes).toEqual([...SCOPES]);
  });

  it('names the presentation, so an operator can say which credential was used', async () => {
    const orgId = await tenant();
    const { issued } = await setup(orgId);
    expect(parsePresented(issued.presented)).toMatchObject({ orgId, keyId: issued.credentialId });
    expect(parsePresented('nonsense')).toBeNull();
    expect(parsePresented(`${orgId}.${issued.credentialId}.short`)).toBeNull();
  });

  it('refuses a wrong secret exactly as it refuses an unknown credential', async () => {
    const orgId = await tenant();
    const { issued } = await setup(orgId);
    const [org, key] = issued.presented.split('.');
    const wrongSecret = await verifyCredential(app, `${org}.${key}.${'x'.repeat(43)}`, PEPPER);
    const unknownKey = await verifyCredential(app, `${org}.${newId('crd')}.${'x'.repeat(43)}`, PEPPER);
    expect(wrongSecret).toEqual({ ok: false, reason: 'AGENT_NOT_FOUND' });
    expect(wrongSecret).toEqual(unknownKey);
  });

  it('will not check one organisation\'s secret with another\'s pepper', async () => {
    const orgId = await tenant();
    const otherOrg = await tenant();
    const { issued } = await setup(orgId);
    const [, key, secret] = issued.presented.split('.');
    expect(await verifyCredential(app, `${otherOrg}.${key}.${secret}`, PEPPER)).toEqual({
      ok: false,
      reason: 'AGENT_NOT_FOUND',
    });
    expect(pepperFor(PEPPER, orgId)).not.toBe(pepperFor(PEPPER, otherOrg));
  });

  it('gives a distinct reason for expiry, revocation, pause and retirement', async () => {
    const orgId = await tenant();
    const { agentId } = await setup(orgId);

    // A credential whose whole lifetime is a millisecond, minted through the normal
    // path rather than by editing the row: the point is that the check runs on what
    // issuance wrote.
    const stale = await asTenant(app, orgId, (tx) =>
      issueCredential(tx, { agentId, scopes: SCOPES, ttlMs: 1n, masterPepper: PEPPER, actor: 'tester' }),
    );
    expect(await verifyCredential(app, stale.presented, PEPPER)).toEqual({
      ok: false,
      reason: 'CREDENTIAL_EXPIRED',
    });

    const { issued: live } = await setup(orgId);
    const revoked = await revokeCredential(app, orgId, live.credentialId);
    expect(revoked).toMatchObject({ revoked: true });
    expect(await verifyCredential(app, live.presented, PEPPER)).toEqual({
      ok: false,
      reason: 'CREDENTIAL_REVOKED',
    });

    await asTenant(app, orgId, (tx) => setAgentStatus(tx, { agentId, status: 'PAUSED', actor: 'tester' }));
    const { issued: pausedWith } = await setup(orgId, agentId);
    expect(await verifyCredential(app, pausedWith.presented, PEPPER)).toEqual({
      ok: false,
      reason: 'AGENT_PAUSED',
    });

    await asTenant(app, orgId, (tx) => setAgentStatus(tx, { agentId, status: 'REVOKED', actor: 'tester' }));
    // Retirement answers before revocation does, even though retiring the agent
    // also revoked the credential: the wider reason is the true one, and an
    // operator told "your credential is revoked" would go and mint another.
    expect(await verifyCredential(app, pausedWith.presented, PEPPER)).toEqual({
      ok: false,
      reason: 'AGENT_REVOKED',
    });
  });

  it('takes an agent\'s credentials with it when the agent is retired', async () => {
    const orgId = await tenant();
    const { agentId } = await setup(orgId);
    await asTenant(app, orgId, (tx) => setAgentStatus(tx, { agentId, status: 'REVOKED', actor: 'tester' }));
    const listed = await asTenant(app, orgId, (tx) => listCredentials(tx, agentId));
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed.map((entry) => entry.status))).toEqual(new Set(['REVOKED']));
  });

  it('says which way the agent moved, when it moved', async () => {
    const orgId = await tenant();
    const { agentId } = await setup(orgId);
    await asTenant(app, orgId, (tx) => setAgentStatus(tx, { agentId, status: 'PAUSED', actor: 'tester' }));
    await asTenant(app, orgId, (tx) => setAgentStatus(tx, { agentId, status: 'ACTIVE', actor: 'tester' }));

    const labels = (await asTenant(app, orgId, (tx) => readEventLog(tx.client, orgId)))
      .filter((event) => event.resourceId === agentId && event.eventType.startsWith('agent.'))
      .map((event) => event.eventType);
    // Two events, two different words. `setAgentStatus` used to write `agent.paused` for any
    // transition that was not a revoke, so a resumed agent left a trail saying it had been
    // paused *again* — and the auditor following "who advanced this" would have been shown a
    // pause where the reality was a person handing the agent back.
    expect(labels).toEqual(['agent.created', 'agent.paused', 'agent.resumed']);
  });

  it('reads a revocation as revoked even when its timestamp is ahead of this process', async () => {
    const orgId = await tenant();
    const { agentId, issued } = await setup(orgId);
    // A clock a few hundred milliseconds apart is ordinary; `revoked_at <= now` treated an
    // ordinary skew as a revocation that had not happened yet, and the stale-capability
    // report — the one an operator uses to answer "what can this agent still do" — said
    // ACTIVE about a credential somebody had just revoked.
    await asTenant(app, orgId, (tx) =>
      tx.client.query(`UPDATE ari.agent_credentials SET revoked_at = now() + interval '30 seconds' WHERE id = $1`, [
        issued.credentialId,
      ]),
    );

    const listed = await asTenant(app, orgId, (tx) => listCredentials(tx, agentId));
    expect(listed.map((entry) => entry.status)).toContain('REVOKED');
    expect(listed.map((entry) => entry.status)).not.toContain('ACTIVE');

    // And the authorizing read was never this function's to weaken: `activeScopes` asks
    // Postgres, and Postgres says the credential is revoked. Two clocks, one verdict.
    const scopes = await asTenant(app, orgId, (tx) => activeScopes(tx, issued.credentialId));
    expect(scopes).toEqual([]);
  });

  it('cannot un-revoke a retired agent, which is what "revoked" has to mean', async () => {
    const orgId = await tenant();
    const { agentId } = await setup(orgId);
    await asTenant(app, orgId, (tx) => setAgentStatus(tx, { agentId, status: 'REVOKED', actor: 'tester' }));
    await expect(
      asTenant(app, orgId, (tx) => setAgentStatus(tx, { agentId, status: 'ACTIVE', actor: 'tester' })),
    ).rejects.toThrow(/cannot change status/);
  });

  it('rotates by superseding, and refuses to leave two live credentials behind', async () => {
    const orgId = await tenant();
    const { agentId, issued } = await setup(orgId);
    const successor = await asTenant(app, orgId, (tx) =>
      rotateCredential(tx, {
        agentId,
        supersedeId: issued.credentialId,
        scopes: SCOPES,
        ttlMs: TTL,
        masterPepper: PEPPER,
        actor: 'tester',
      }),
    );

    expect((await verifyCredential(app, successor.presented, PEPPER)).ok).toBe(true);
    expect(await verifyCredential(app, issued.presented, PEPPER)).toEqual({
      ok: false,
      reason: 'CREDENTIAL_REVOKED',
    });

    // Rotating an already-superseded credential is not a rotation. It must fail, and
    // the mint it made on the way to failing has to go back with it — a second live
    // secret is exactly the state rotation exists to end.
    await expect(
      asTenant(app, orgId, (tx) =>
        rotateCredential(tx, {
          agentId,
          supersedeId: issued.credentialId,
          scopes: SCOPES,
          ttlMs: TTL,
          masterPepper: PEPPER,
          actor: 'tester',
        }),
      ),
    ).rejects.toThrow(/could not be superseded/);
    const listed = await asTenant(app, orgId, (tx) => listCredentials(tx, agentId));
    expect(listed.filter((entry) => entry.status === 'ACTIVE')).toHaveLength(1);
  });

  it('decides revocation and expiry on the database clock, not on this process\'s', async () => {
    // The regression this pins. `revoked_at` and `expires_at` are both written by the
    // database, so both are judged there. Before, `verifyCredential` compared each to a
    // caller-supplied time, and a process whose clock ran behind kept a retired credential
    // authenticating for as long as it took to catch up — a window with no bound and no
    // attacker in it.
    //
    // Every parameter that used to decide the verdict is now gone from the signature, so the
    // only way to test the property is to make this process's clock disagree with the
    // database's on purpose. All writes happen on the real clock; the fake one is turned on
    // only for the reads, so nothing is dated by a lie. Both final assertions return `ok:
    // true` against the old comparison, which is what makes them the test rather than a demo.
    const orgId = await tenant();
    const { agentId, issued } = await setup(orgId);

    await asTenant(app, orgId, (tx) =>
      rotateCredential(tx, {
        agentId,
        supersedeId: issued.credentialId,
        scopes: SCOPES,
        ttlMs: TTL,
        masterPepper: PEPPER,
        actor: 'tester',
      }),
    );
    const stale = await asTenant(app, orgId, (tx) =>
      issueCredential(tx, { agentId, scopes: SCOPES, ttlMs: 1n, masterPepper: PEPPER, actor: 'tester' }),
    );
    // Past its own one-millisecond instant by the database's clock already.
    await new Promise((resolve) => setTimeout(resolve, 5));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2000-01-01T00:00:00.000Z'));

      expect(await verifyCredential(app, issued.presented, PEPPER)).toEqual({
        ok: false,
        reason: 'CREDENTIAL_REVOKED',
      });
      expect(await verifyCredential(app, stale.presented, PEPPER)).toEqual({
        ok: false,
        reason: 'CREDENTIAL_EXPIRED',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a credential with no scopes, and one that cannot expire', async () => {
    const orgId = await tenant();
    const { agentId } = await setup(orgId);
    await expect(
      asTenant(app, orgId, (tx) => issueCredential(tx, { agentId, scopes: [], ttlMs: TTL, masterPepper: PEPPER, actor: 'tester' })),
    ).rejects.toThrow(/no scopes/);
    await expect(
      asTenant(app, orgId, (tx) => issueCredential(tx, { agentId, scopes: SCOPES, ttlMs: 0n, masterPepper: PEPPER, actor: 'tester' })),
    ).rejects.toThrow(/expire/);
  });
});

describe('the tenant boundary holds below the application', () => {
  it('hides another organisation\'s rows even from a query with no filter', async () => {
    const a = await tenant();
    const b = await tenant();
    const agentInA = await asTenant(app, a, (tx) => createAgent(tx, { name: 'a-agent', createdBy: 'tester' }));
    await asTenant(app, b, (tx) => createAgent(tx, { name: 'b-agent', createdBy: 'tester' }));

    const unfiltered = await asTenant(app, a, (tx) => tx.client.query(`SELECT id FROM ari.agents`));
    expect(unfiltered.rows).toEqual([{ id: agentInA }]);

    const aimedAtOther = await asTenant(app, a, (tx) =>
      tx.client.query(`SELECT id FROM ari.agents WHERE org_id = $1`, [b]),
    );
    expect(aimedAtOther.rowCount).toBe(0);
  });

  it('covers every tenant-bearing table, not only the ones with a repository', async () => {
    const a = await tenant();
    const b = await tenant();
    const agentInA = await asTenant(app, a, async (tx) => {
      const agent = await createAgent(tx, { name: 'a', createdBy: 'tester' });
      await createUser(tx, { email: 'viewer@a.test', displayName: 'A', role: 'viewer', grantedBy: 'tester' });
      return agent;
    });
    await asTenant(app, b, async (tx) => {
      const agent = await createAgent(tx, { name: 'b', createdBy: 'tester' });
      const wallet = await createWallet(tx, {
        displayName: 'b-wallet',
        mode: 'delegated',
        signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
        provider: 'mock',
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        actor: 'tester',
      });
      await grantWalletToAgent(tx, { agentId: agent, walletId: wallet, policyVersionId: newId('ppv'), actor: 'tester' });
      await createUser(tx, { email: 'someone@b.test', displayName: 'B', role: 'approver', grantedBy: 'tester' });
      await recordRequest(tx, {
        agentId: agent,
        walletId: wallet,
        idempotencyKey: 'b-inv',
        canonical: 'o{b}',
        digest: `canon/v1:${'9'.repeat(64)}`,
      });
      return agent;
    });

    const tables = [
      'users',
      'memberships',
      'agents',
      'agent_credentials',
      'wallets',
      'agent_wallet_grants',
      'transaction_requests',
    ];
    for (const table of tables) {
      const rows = await asTenant(app, a, (tx) => tx.client.query(`SELECT * FROM ari.${table}`));
      for (const row of rows.rows as Record<string, unknown>[]) {
        if (row.org_id !== undefined) expect(row.org_id, `tenant A reached ${table} rows of tenant B`).toBe(a);
      }
    }
    const own = await asTenant(app, a, (tx) => tx.client.query(`SELECT id FROM ari.agents WHERE id = $1`, [agentInA]));
    expect(own.rowCount).toBe(1);
  });

  it('refuses a write aimed at another organisation', async () => {
    const a = await tenant();
    const b = await tenant();
    await expect(
      asTenant(app, a, (tx) =>
        tx.client.query(`INSERT INTO ari.agents (id, org_id, name, created_by) VALUES ($1, $2, 'x', 'y')`, [
          newId('agt'),
          b,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('sees nothing at all when no tenant is set', async () => {
    const client = await appPool.connect();
    try {
      await client.query(`SET ROLE ari_app`);
      expect((await client.query(`SELECT id FROM ari.agents`)).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('refuses a tenant key that is not one', async () => {
    await expect(asTenant(app, 'org_; drop table ari.agents', () => Promise.resolve(0))).rejects.toThrow(RangeError);
  });
});

describe('wallets, grants and requests', () => {
  const walletFields = {
    mode: 'user_gated' as const,
    signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
    provider: 'mock',
    actor: 'tester',
  };

  it('will not change a wallet\'s guarantee after creation', async () => {
    const orgId = await tenant();
    const walletId = await asTenant(app, orgId, (tx) =>
      createWallet(tx, { ...walletFields, displayName: 'payables' }),
    );
    // Ika documents conversion to shared as irreversible, so a row that permitted
    // the update would let the product keep claiming a guarantee the wallet had
    // already given away (ASSUMPTIONS I16, §4.7a).
    await expect(
      pool.query(`UPDATE ari.wallets SET mode = 'delegated' WHERE id = $1`, [walletId]),
    ).rejects.toThrow(/guarantee is immutable/);
  });

  it('reuses a request for a retry and refuses it for a different transaction', async () => {
    const orgId = await tenant();
    const { agentId } = await setup(orgId);
    const walletId = await asTenant(app, orgId, (tx) => createWallet(tx, { ...walletFields, displayName: 'w' }));
    const content = { canonical: 'o{a}', digest: `canon/v1:${'1'.repeat(64)}` };

    const made = await asTenant(app, orgId, (tx) =>
      recordRequest(tx, { agentId, walletId, idempotencyKey: 'inv-1', ...content }),
    );
    const retried = await asTenant(app, orgId, (tx) =>
      recordRequest(tx, { agentId, walletId, idempotencyKey: 'inv-1', ...content }),
    );
    expect(made.reused).toBe(false);
    // The retry gets the same answer, not the same record: `reused` is the bit that
    // tells the caller it is looking at a replay, and it has to differ.
    expect(retried.id).toBe(made.id);
    expect(retried.reused).toBe(true);

    await expect(
      asTenant(app, orgId, (tx) =>
        recordRequest(tx, {
          agentId,
          walletId,
          idempotencyKey: 'inv-1',
          canonical: 'o{b}',
          digest: `canon/v1:${'2'.repeat(64)}`,
        }),
      ),
    ).rejects.toThrow(/idempotency conflict/);
  });

  it('advances a request only from the state it is actually in', async () => {
    const orgId = await tenant();
    const { agentId } = await setup(orgId);
    const walletId = await asTenant(app, orgId, (tx) => createWallet(tx, { ...walletFields, displayName: 'w' }));
    const { id } = await asTenant(app, orgId, (tx) =>
      recordRequest(tx, {
        agentId,
        walletId,
        idempotencyKey: 'inv-cas',
        canonical: 'o{a}',
        digest: `canon/v1:${'3'.repeat(64)}`,
      }),
    );

    await asTenant(app, orgId, (tx) =>
      setRequestState(tx, { requestId: id, from: 'DRAFT', to: 'VALIDATED', actor: 'system' }),
    );
    await expect(
      asTenant(app, orgId, (tx) =>
        setRequestState(tx, { requestId: id, from: 'DRAFT', to: 'EVALUATING', actor: 'system' }),
      ),
    ).rejects.toThrow(/not in DRAFT/);
  });

  it('measures a recipient\'s first appearance against money that actually settled', async () => {
    // The regression this exists for: the reader coerced `min(created_at)` with a
    // `?? 'NaN'` chained through `BigInt()`. Over zero rows the aggregate still returns
    // a row, whose value is NULL, so the `??` never fired and `BigInt('NaN')` threw —
    // on the *first* payment to any address, which is the one case a novelty rule is
    // there to answer. It arrived as a 500 with no decision and no audit event, on the
    // path that has no history to fall back on.
    const orgId = await tenant();
    const { agentId } = await setup(orgId);
    const walletId = await asTenant(app, orgId, (tx) => createWallet(tx, { ...walletFields, displayName: 'w' }));
    const recipient = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';

    expect(await asTenant(app, orgId, (tx) => recipientFirstSeenAt(tx, { walletId, address: recipient }))).toBeNull();

    const { id } = await asTenant(app, orgId, (tx) =>
      recordRequest(tx, {
        agentId,
        walletId,
        idempotencyKey: 'novelty',
        canonical: 'o{n}',
        digest: `canon/v1:${'3'.repeat(64)}`,
        recipientAddress: recipient,
        amountRaw: 1_000_000n,
      }),
    );
    // Proposed is not paid. A recipient Ari authorised once and never actually received
    // is still novel, which is why the predicate names three states rather than "any row".
    expect(await asTenant(app, orgId, (tx) => recipientFirstSeenAt(tx, { walletId, address: recipient }))).toBeNull();

    const walked = await asTenant(app, orgId, async (tx) => {
      const path = [
        ['DRAFT', 'VALIDATED'],
        ['VALIDATED', 'EVALUATING'],
        ['EVALUATING', 'RESERVED'],
        ['RESERVED', 'TICKET_MINTED'],
        ['TICKET_MINTED', 'SIGNING_PENDING'],
        ['SIGNING_PENDING', 'SIGNING_COMPLETE'],
      ] as const;
      for (const [from, to] of path) {
        await setRequestState(tx, { requestId: id, from, to, actor: 'system' });
      }
      return recipientFirstSeenAt(tx, { walletId, address: recipient });
    });
    if (walked === null) throw new Error('a settled payment did not make its recipient familiar');
    // Epoch *milliseconds*, and asserted as a magnitude rather than a type: `getTime()`
    // is ms while `to_timestamp` wants seconds, and this repo has been bitten by that
    // confusion twice. A value below 10¹² would be seconds, and would make every
    // recipient look centuries stale.
    expect(walked > 1_700_000_000_000n).toBe(true);

    // Per (wallet, recipient), not per wallet: the same wallet paying a different
    // address is still a new recipient.
    expect(
      await asTenant(app, orgId, (tx) =>
        recipientFirstSeenAt(tx, { walletId, address: '0x1111111111111111111111111111111111111111' }),
      ),
    ).toBeNull();
  });

  it('records a role change at the severity that makes it visible', async () => {
    const orgId = await tenant();
    const ownerId = await asTenant(app, orgId, (tx) =>
      createUser(tx, { email: 'owner@a.test', displayName: 'Owner', role: 'owner', grantedBy: 'system' }),
    );
    await asTenant(app, orgId, (tx) => changeUserRole(tx, { userId: ownerId, role: 'approver', actor: ownerId }));

    const rows = await pool.query<{ severity: string }>(
      `SELECT severity FROM ari.audit_events
        WHERE org_id = $1 AND event_type = 'user.role_changed' ORDER BY seq`,
      [orgId],
    );
    expect(rows.rows[0]?.severity).toBe('warning');
    expect((await verifyChain(pool, orgId)).ok).toBe(true);
  });

  it('writes every identity change into the same chain, in the transaction that made it', async () => {
    const orgId = await tenant();
    const { agentId, issued } = await setup(orgId);
    const report = await verifyChain(pool, orgId);
    expect(report.ok).toBe(true);
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM ari.audit_events WHERE org_id = $1 ORDER BY seq`,
      [orgId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'organization.created',
      'agent.created',
      'credential.issued',
    ]);
    expect(issued.credentialId).toMatch(/^crd_/);
    expect(agentId).toMatch(/^agt_/);
  });
});
