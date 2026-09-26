/**
 * Human approval — Phase 6's gate.
 *
 * The claims under test are the ones the whole product rests on: that a person
 * approved *this* transaction, that their approval can only be spent once, and that
 * the person who proposed a widening is not the person who waves it through. All
 * three are easy to assert in a mock and impossible to assert without a database,
 * because each is a statement about concurrent writes.
 */

import { newId } from '@ari/schemas';
import type { CanonicalDigest } from '@ari/schemas';
import {
  ApprovalKey,
  claimApproval,
  recordDecision,
  requestApproval,
} from '@ari/approvals';
import * as approvalsModule from '@ari/approvals';
import { createOrganization, createUser, asTenant, type Connector } from '@ari/identity';
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

const KEY = new ApprovalKey('s'.repeat(48));
const OTHER_TENANT_KEY = new ApprovalKey('t'.repeat(48));
const DIGEST = `canon/v1:${'7'.repeat(64)}` as CanonicalDigest;
const OTHER_DIGEST = `canon/v1:${'8'.repeat(64)}` as CanonicalDigest;

beforeAll(async () => {
  pool = await connect();
  appPool = await connect(4);
});

afterAll(async () => {
  await appPool?.end();
  await pool?.end();
});

type UserRole = 'owner' | 'admin' | 'approver' | 'viewer';

/**
 * The map type is generic over the caller's own labels so `users.alice` is a
 * `string` rather than a `string | undefined`: a fixture whose lookups all need
 * narrowing is a fixture that will quietly test nothing.
 */
async function tenant<R extends Record<string, UserRole>>(roles: R) {
  const orgId = await createOrganization(app, { name: 'Approvers', bootstrapActor: 'system' });
  const users = await asTenant(app, orgId, async (tx) => {
    const entries = {} as Record<keyof R, string>;
    for (const [label, role] of Object.entries(roles) as [keyof R, UserRole][]) {
      entries[label] = await createUser(tx, {
        email: `${String(label)}.${orgId.slice(4, 8)}@a.test`,
        displayName: String(label),
        role,
        grantedBy: 'system',
      });
    }
    return entries;
  });
  return { orgId, users };
}

/** Approve and reach quorum, which several of the claim tests below need done first. */
async function approveOnce(orgId: string, approver: string, approvalId: string) {
  return asTenant(app, orgId, (tx) =>
    recordDecision(tx, { approvalId, approver, decision: 'APPROVED' }),
  );
}

interface ApprovalArgs {
  readonly subjectKind?: 'transaction' | 'policy_activation';
  readonly quorum?: number;
  readonly ttlMs?: bigint;
  readonly requestedBy?: string;
  readonly digest?: CanonicalDigest;
}

async function openApprovalRequest(orgId: string, actor: string, args: ApprovalArgs = {}) {
  return asTenant(app, orgId, (tx) =>
    requestApproval(tx, {
      subjectKind: args.subjectKind ?? 'transaction',
      subjectId: newId('txr'),
      requestId: newId('req'),
      digest: args.digest ?? DIGEST,
      policyVersionId: newId('ppv'),
      agentId: newId('agt'),
      walletId: newId('wal'),
      amountRaw: 2_000_000_000n,
      currencyUnit: 'usdc-6dp',
      quorumNeeded: args.quorum ?? 1,
      allowedRoles: ['owner', 'approver'],
      requestedBy: args.requestedBy ?? actor,
      ttlMs: args.ttlMs ?? 600_000n,
      key: KEY,
    }),
  );
}

async function events(orgId: string, type: string) {
  return pool.query<{ severity: string; reason_codes: string[]; metadata: Record<string, string> }>(
    `SELECT severity, reason_codes, metadata FROM ari.audit_events WHERE org_id = $1 AND event_type = $2 ORDER BY seq`,
    [orgId, type],
  );
}

async function status(approvalId: string) {
  const rows = await pool.query<{ status: string; consumed_at: Date | null }>(
    `SELECT status, consumed_at FROM ari.approval_requests WHERE id = $1`,
    [approvalId],
  );
  return rows.rows[0];
}

describe('quorum', () => {
  it('grants only when the votes are actually in', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', bob: 'approver', carol: 'viewer' });
    const request = await openApprovalRequest(orgId, users.alice, { quorum: 2 });

    const first = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    expect(first).toMatchObject({ ok: true, status: 'PENDING', votes: 1 });

    const claimed = await claimApproval(app, orgId, request.token, DIGEST, KEY);
    expect(claimed).toMatchObject({ ok: false, code: 'QUORUM_NOT_REACHED' });

    const second = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.bob, decision: 'APPROVED' }),
    );
    expect(second).toMatchObject({ ok: true, status: 'GRANTED', votes: 2 });

    expect((await status(request.approvalId))?.status).toBe('GRANTED');
  });

  it('counts a person once, however often they decide', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', bob: 'approver' });
    const request = await openApprovalRequest(orgId, users.alice, { quorum: 2 });
    await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    const again = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    expect(again).toMatchObject({ ok: false, detail: 'this approver has already decided' });
    expect((await status(request.approvalId))?.status).toBe('PENDING');

    // ...and the tally is unaffected, which is the only reason quorum means anything.
    const votes = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ari.approvals WHERE approval_request_id = $1`,
      [request.approvalId],
    );
    expect(votes.rows[0]?.count).toBe('1');
  });

  it('settles a race between two approvers to exactly one grant', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', bob: 'approver', carol: 'admin' });
    const request = await openApprovalRequest(orgId, users.alice, { quorum: 2 });
    const outcomes = await Promise.all(
      [users.alice, users.bob, users.carol].map((approver) =>
        asTenant(app, orgId, (tx) =>
          recordDecision(tx, { approvalId: request.approvalId, approver, decision: 'APPROVED' }),
        ),
      ),
    );
    const granted = outcomes.filter((outcome) => outcome.ok && outcome.status === 'GRANTED');
    expect(granted).toHaveLength(1);
    expect((await status(request.approvalId))?.status).toBe('GRANTED');
  });

  it('treats one rejection as terminal', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', bob: 'approver' });
    const request = await openApprovalRequest(orgId, users.alice, { quorum: 2 });
    await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.bob, decision: 'REJECTED' }),
    );
    expect((await status(request.approvalId))?.status).toBe('REJECTED');

    const late = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    expect(late).toMatchObject({ ok: false, code: 'APPROVAL_ALREADY_CONSUMED' });
    const claimed = await claimApproval(app, orgId, request.token, DIGEST, KEY);
    expect(claimed.ok).toBe(false);
  });
});

describe('who may approve', () => {
  it('refuses a role the policy did not name, and records the refusal', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', vince: 'viewer' });
    const request = await openApprovalRequest(orgId, users.alice);
    const refused = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.vince, decision: 'APPROVED' }),
    );
    expect(refused).toMatchObject({ ok: false, code: 'APPROVER_NOT_AUTHORISED' });
    const refusal = await events(orgId, 'approval.claim_refused');
    expect(refusal.rows[0]?.severity).toBe('critical');
    expect(refusal.rows[0]?.reason_codes).toContain('APPROVER_NOT_AUTHORISED');
  });

  it('refuses someone with no membership at all, rather than treating absence as a role', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice);
    const refused = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: newId('usr'), decision: 'APPROVED' }),
    );
    expect(refused).toMatchObject({ ok: false, code: 'APPROVER_NOT_AUTHORISED', detail: 'role none' });
  });

  it('will not let the proposer approve the change that widens their own authority (T19)', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', bob: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice, {
      subjectKind: 'policy_activation',
      quorum: 1,
      requestedBy: users.alice,
    });

    const self = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    expect(self).toMatchObject({ ok: false, detail: 'self-approval' });

    // The same change approved by a different owner is legal: the guard is against
    // one person both proposing and signing off, not against the change itself.
    const other = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.bob, decision: 'APPROVED' }),
    );
    expect(other).toMatchObject({ ok: true, status: 'GRANTED' });
  });

  it('does allow the proposer to approve an ordinary payment', async () => {
    // The distinction matters: an owner who requested a payment may also approve it,
    // because nothing about it enlarges what they are permitted to do.
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice, { requestedBy: users.alice });
    const decided = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    expect(decided).toMatchObject({ ok: true, status: 'GRANTED' });
  });
});

describe('single use, and what a second attempt looks like', () => {
  it('spends an approval once', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice);
    await approveOnce(orgId, users.alice, request.approvalId);
    const first = await claimApproval(app, orgId, request.token, DIGEST, KEY);
    expect(first.ok).toBe(true);
    expect((await status(request.approvalId))?.consumed_at).not.toBeNull();

    const second = await claimApproval(app, orgId, request.token, DIGEST, KEY);
    expect(second).toMatchObject({ ok: false, code: 'APPROVAL_ALREADY_CONSUMED' });

    // The event is the point: a replay has to be distinguishable from a retry.
    const reuse = await events(orgId, 'approval_reuse_attempted');
    expect(reuse.rows).toHaveLength(1);
    expect(reuse.rows[0]?.reason_codes).toContain('APPROVAL_ALREADY_CONSUMED');
  });

  it('admits exactly one of three simultaneous claims', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice);
    await approveOnce(orgId, users.alice, request.approvalId);
    const claims = await Promise.all([
      claimApproval(app, orgId, request.token, DIGEST, KEY),
      claimApproval(app, orgId, request.token, DIGEST, KEY),
      claimApproval(app, orgId, request.token, DIGEST, KEY),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect((await events(orgId, 'approval_reuse_attempted')).rowCount).toBe(2);
  });

  it('refuses to spend on a digest that is not the one that was approved (T12)', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice);
    await approveOnce(orgId, users.alice, request.approvalId);
    const mismatched = await claimApproval(app, orgId, request.token, OTHER_DIGEST, KEY);
    expect(mismatched).toMatchObject({ ok: false, code: 'APPROVAL_DIGEST_MISMATCH' });

    // And the approval is *not* consumed by a failed presentation: if it were, an
    // attacker able to guess a digest could deny a legitimate payment its authority.
    expect((await status(request.approvalId))?.status).toBe('GRANTED');
    const rightful = await claimApproval(app, orgId, request.token, DIGEST, KEY);
    expect(rightful.ok).toBe(true);
  });

  it('refuses to spend an approval that is still waiting for votes', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', bob: 'approver' });
    const request = await openApprovalRequest(orgId, users.alice, { quorum: 2 });
    expect(await claimApproval(app, orgId, request.token, DIGEST, KEY)).toMatchObject({
      ok: false,
      code: 'QUORUM_NOT_REACHED',
    });
    // Nothing consumed, and nothing recorded as a replay: an incomplete quorum is
    // not an attack, and `approval_reuse_attempted` has to keep meaning replay.
    expect((await status(request.approvalId))?.status).toBe('PENDING');
    expect((await events(orgId, 'approval_reuse_attempted')).rowCount).toBe(0);
  });

  it('expires', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice, { ttlMs: 1n });
    const late = await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    expect(late).toMatchObject({ ok: false, code: 'APPROVAL_EXPIRED' });
    expect((await status(request.approvalId))?.status).toBe('EXPIRED');
    expect(await claimApproval(app, orgId, request.token, DIGEST, KEY)).toMatchObject({
      ok: false,
      code: 'APPROVAL_EXPIRED',
    });
  });
});

describe('the token and the tenant', () => {
  it('will not redeem a token in another organisation', async () => {
    const a = await tenant({ alice: 'owner' });
    const b = await tenant({ bruce: 'owner' });
    const request = await openApprovalRequest(a.orgId, a.users.alice);
    await approveOnce(a.orgId, a.users.alice, request.approvalId);

    expect(await claimApproval(app, b.orgId, request.token, DIGEST, KEY)).toMatchObject({
      ok: false,
      code: 'APPROVAL_NOT_FOUND',
    });
    // Still spendable where it belongs, so a cross-tenant attempt is not a way to
    // consume someone else's approval.
    expect((await claimApproval(app, a.orgId, request.token, DIGEST, KEY)).ok).toBe(true);
  });

  it('will not redeem a token sealed under a different key', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice);
    expect(await claimApproval(app, orgId, request.token, DIGEST, OTHER_TENANT_KEY)).toMatchObject({
      ok: false,
      code: 'APPROVAL_NOT_FOUND',
    });
  });

  it('hides one tenant\'s approvals and requests from another', async () => {
    const a = await tenant({ alice: 'owner' });
    const b = await tenant({ bruce: 'owner' });
    await openApprovalRequest(a.orgId, a.users.alice);
    const peek = await asTenant(app, b.orgId, (tx) => tx.client.query(`SELECT id FROM ari.approval_requests`));
    expect(peek.rowCount).toBe(0);
  });

  it('refuses to mark a grant that has no votes behind it', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice, { quorum: 2 });
    await expect(
      pool.query(`UPDATE ari.approval_requests SET status = 'GRANTED' WHERE id = $1`, [request.approvalId]),
    ).rejects.toThrow(/cannot become GRANTED without/);
  });

  it('keeps the recorded votes immutable', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice);
    await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    await expect(
      pool.query(`UPDATE ari.approvals SET decision = 'REJECTED' WHERE approval_request_id = $1`, [request.approvalId]),
    ).rejects.toThrow(/recorded once/);
  });
});

describe('what approval is not', () => {
  it('hands back no authority to sign', async () => {
    const { orgId, users } = await tenant({ alice: 'owner' });
    const request = await openApprovalRequest(orgId, users.alice);
    await approveOnce(orgId, users.alice, request.approvalId);
    const claim = await claimApproval(app, orgId, request.token, DIGEST, KEY);
    if (!claim.ok) throw new Error('expected the claim to succeed');
    // The result is a receipt, not a capability: it says which approval was spent and
    // over which digest. Minting a ticket is a separate act by the decision plane,
    // and nothing in this module can do it — see the export list below.
    expect(Object.keys(claim).sort()).toEqual(['approvalId', 'digest', 'ok']);
  });

  it('exports no way to seal a ticket', () => {
    // A structural claim, checked against the module's own surface rather than
    // against a comment: approving must not be one import away from signing.
    const exported = Object.keys(approvalsModule);
    expect(exported.filter((name) => /ticket|Ticket|sign|Sign/.test(name))).toEqual([]);
  });

  it('leaves a verifiable chain behind', async () => {
    const { orgId, users } = await tenant({ alice: 'owner', bob: 'approver' });
    const request = await openApprovalRequest(orgId, users.alice, { quorum: 2 });
    await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.alice, decision: 'APPROVED' }),
    );
    await asTenant(app, orgId, (tx) =>
      recordDecision(tx, { approvalId: request.approvalId, approver: users.bob, decision: 'APPROVED' }),
    );
    await claimApproval(app, orgId, request.token, DIGEST, KEY);
    const report = await verifyChain(pool, orgId);
    expect(report.breaks).toEqual([]);
    expect(report.events).toBeGreaterThanOrEqual(5);
  });
});
