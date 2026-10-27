/**
 * The rules the application believed, written as tests against the schema.
 *
 * `014` closes six conventions — a revocation that a second statement could undo, an
 * approval whose bytes were editable while humans were voting on them, a vote that named no
 * authority, a window keyed in a way its dimension did not describe, a person who could hold
 * two roles, a published policy that could return with nothing written down. None was
 * reachable through Ari's API, which is exactly what makes them invisible to the suites that
 * exercise the API: every one of them was green before the migration and would stay green
 * after it, if the tests asked the code instead of asking the database.
 *
 * So each test here writes the statement directly, as the role that could write it, and
 * asserts the refusal. The paired control — that the legitimate statement still works — sits
 * next to each one, because a constraint that refuses everything is an outage and would pass
 * every assertion below just as happily.
 */

import { requestApproval, recordDecision, ApprovalKey } from '@ari/approvals';
import {
  asTenant,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  issueCredential,
  type Scope,
} from '@ari/identity';
import { newId, type CanonicalDigest } from '@ari/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './database.js';

const DIGEST = `canon/v1:${'c'.repeat(64)}` as CanonicalDigest;
const OTHER = `canon/v1:${'d'.repeat(64)}` as CanonicalDigest;
const PEPPER = 'immutability-test-pepper-0123456789abcdef';
const KEY = new ApprovalKey('approval-key-for-the-immutability-suite-0123');

let pool: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  pool = await connect();
});

afterAll(async () => {
  await pool?.end();
});

interface Fixture {
  readonly orgId: string;
  readonly owner: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly credentialId: string;
}

async function fixture(): Promise<Fixture> {
  const orgId = await createOrganization(pool, { name: 'Immutable', bootstrapActor: 'system' });
  return asTenant(pool, orgId, async (tx) => {
    const owner = await createUser(tx, {
      email: `o-${orgId.slice(4, 10)}@x.test`,
      displayName: 'O',
      role: 'owner',
      grantedBy: 'system',
    });
    const agentId = await createAgent(tx, { name: 'pay', createdBy: owner });
    const walletId = await createWallet(tx, {
      displayName: 'w',
      mode: 'delegated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      provider: 'mock',
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      actor: owner,
    });
    const credential = await issueCredential(tx, {
      agentId,
      scopes: ['transaction:request'] as Scope[],
      ttlMs: 3_600_000n,
      masterPepper: PEPPER,
      actor: owner,
    });
    return { orgId, owner, agentId, walletId, credentialId: credential.credentialId };
  });
}

/** A real open approval, requested through the package rather than hand-inserted. */
async function openApproval(t: Fixture, quorum = 1) {
  return asTenant(pool, t.orgId, async (tx) => {
    const opened = await requestApproval(tx, {
      subjectKind: 'transaction',
      subjectId: newId('txr'),
      requestId: newId('req'),
      digest: DIGEST,
      policyVersionId: newId('ppv'),
      agentId: t.agentId,
      walletId: t.walletId,
      amountRaw: 2_000_000_000n,
      currencyUnit: 'usdc-6dp',
      quorumNeeded: quorum,
      allowedRoles: ['owner'],
      requestedBy: t.agentId,
      ttlMs: 900_000n,
      key: KEY,
    });
    return { ...opened, policyVersionId: 'ppv' };
  });
}

/**
 * A vote written straight into the table, as anything other than `recordDecision` would.
 *
 * The defaults are the *valid* ones, so each test changes only the one field it means to
 * refuse: a fixture that was already invalid would pass for the wrong reason.
 */
function forged(t: Fixture, approvalId: string, over: Partial<{ approver: string; role: string; digest: string }>) {
  return pool.query(
    `INSERT INTO ari.approvals (id, approval_request_id, org_id, approver_user_id, role, decision, digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId('apr'), approvalId, t.orgId, over.approver ?? t.owner, over.role ?? 'owner', 'APPROVED', over.digest ?? DIGEST],
  );
}

describe('a credential is minted, used and revoked — never edited, never revived', () => {
  const edits: readonly { readonly name: string; readonly sql: string }[] = [
    { name: 'un-revokes it', sql: 'SET revoked_at = NULL' },
    { name: 'moves it to another agent', sql: `SET agent_id = '${newId('agt')}'` },
    { name: 'moves it to another tenant', sql: `SET org_id = '${newId('org')}'` },
    { name: 'widens its scopes', sql: `SET scopes = ARRAY['transaction:request','transaction:read','approval:decide']` },
    { name: 'swaps its secret', sql: `SET secret_hash = '$argon2id$fake'` },
    { name: 'extends its expiry', sql: `SET expires_at = now() + interval '365 days'` },
    { name: 're-points its lineage', sql: `SET rotation_of = '${newId('crd')}'` },
  ];

  it('refuses every one, to the role the service holds', async () => {
    const t = await fixture();
    await asTenant(pool, t.orgId, (tx) =>
      tx.client.query(`UPDATE ari.agent_credentials SET revoked_at = now() WHERE id = $1`, [t.credentialId]),
    );

    const app = await connect(1, 'ari_app');
    try {
      for (const edit of edits) {
        await asTenant(app, t.orgId, async (tx) => {
          await expect(
            tx.client.query(`UPDATE ari.agent_credentials ${edit.sql} WHERE id = $1`, [t.credentialId]),
            `the database accepted an edit that ${edit.name}`
          ).rejects.toThrow(/not editable|does not become live again/);
        });
      }
    } finally {
      await app.end();
    }

    // The control, and the reason it matters most here: retirement cascades to credentials,
    // rotation supersedes them, and both write this same table. If the guard refused those,
    // S14 would be an outage rather than a control.
    const stillRevoked = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM ari.agent_credentials WHERE id = $1`,
      [t.credentialId],
    );
    expect(stillRevoked.rows[0]?.revoked_at).toBeInstanceOf(Date);
  });

  it('still dates a fresh revocation, and treats a second one as nothing to do', async () => {
    const t = await fixture();
    const first = await asTenant(pool, t.orgId, (tx) =>
      tx.client.query<{ id: string }>(
        `UPDATE ari.agent_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [t.credentialId],
      ),
    );
    expect(first.rowCount).toBe(1);
    const second = await asTenant(pool, t.orgId, (tx) =>
      tx.client.query<{ id: string }>(
        `UPDATE ari.agent_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [t.credentialId],
      ),
    );
    expect(second.rowCount).toBe(0);
  });

  it('holds the same line for a human credential', async () => {
    const t = await fixture();
    const userId = await asTenant(pool, t.orgId, (tx) =>
      createUser(tx, { email: 'a@x.test', displayName: 'A', role: 'approver', grantedBy: 'system' }),
    );
    // Issued and revoked in one transaction: `now()` is fixed at the transaction's start, so
    // `revoked_at = now()` equals `created_at`, and `014` relaxes `>` to `>=` for exactly this
    // case. An operator catching a mistyped scope a second later is not revoking the past.
    const credentialId = await asTenant(pool, t.orgId, async (tx) => {
      const issued = await tx.client.query<{ id: string }>(
        `INSERT INTO ari.user_credentials (id, org_id, user_id, key_id, secret_hash, scopes, expires_at)
         VALUES ($1,$2,$3,$4,'x',ARRAY['approval:decide'],now() + interval '1 hour')
         RETURNING id`,
        [newId('ucrd'), t.orgId, userId, newId('ucrd')],
      );
      const id = issued.rows[0]?.id;
      if (id === undefined) throw new Error('the user credential did not land');
      await tx.client.query(`UPDATE ari.user_credentials SET revoked_at = now() WHERE id = $1`, [id]);
      return id;
    });

    await expect(
      pool.query(`UPDATE ari.user_credentials SET revoked_at = NULL WHERE id = $1`, [credentialId]),
    ).rejects.toThrow(/does not become live again/);
    await expect(
      pool.query(`UPDATE ari.user_credentials SET scopes = ARRAY['approval:decide','policy:activate'] WHERE id = $1`, [credentialId]),
    ).rejects.toThrow(/not editable/);
  });

  it('keeps the two subjects on opposite sides of the boundary (013)', async () => {
    const t = await fixture();
    // An agent credential that could approve would let one secret propose a payment and
    // approve it. `013` refuses it in a CHECK, and `014` refuses editing it in.
    await expect(
      asTenant(pool, t.orgId, (tx) =>
        tx.client.query(
          `INSERT INTO ari.agent_credentials (id, org_id, agent_id, key_id, secret_hash, scopes, expires_at)
           VALUES ($1,$2,$3,$4,'x',ARRAY['transaction:request','approval:decide'],now() + interval '1 hour')`,
          [newId('crd'), t.orgId, t.agentId, newId('crd')],
        ),
      ),
    ).rejects.toThrow(/agent_credential_cannot_approve|check constraint/);

    await expect(
      asTenant(pool, t.orgId, (tx) =>
        tx.client.query(`UPDATE ari.agent_credentials SET scopes = ARRAY['approval:decide'] WHERE id = $1`, [t.credentialId]),
      ),
    ).rejects.toThrow(/not editable/);
  });
});

describe('an approval is frozen while its humans are voting', () => {
  const edits: readonly { readonly name: string; readonly sql: string }[] = [
    { name: 'swaps the bytes approved', sql: `SET digest = '${OTHER}'` },
    { name: 'lowers the amount', sql: 'SET amount_raw = 1' },
    { name: 'drops the quorum', sql: 'SET quorum_needed = 0' },
    { name: 'widens the roles', sql: `SET allowed_roles = ARRAY['owner','viewer']` },
    { name: 'extends the window', sql: `SET expires_at = now() + interval '30 days'` },
    { name: 'moves it to another request', sql: `SET subject_id = '${newId('txr')}'` },
    { name: 'moves it to another wallet', sql: `SET wallet_id = '${newId('wal')}'` },
    { name: 're-attributes the proposer', sql: `SET requested_by = '${newId('usr')}'` },
  ];

  it('refuses each, and still writes the status', async () => {
    const t = await fixture();
    const opened = await openApproval(t);

    for (const edit of edits) {
      await expect(
        pool.query(`UPDATE ari.approval_requests ${edit.sql} WHERE id = $1`, [opened.approvalId]),
        `the database accepted an edit that ${edit.name}`,
      ).rejects.toThrow(/not editable|already voting/);
    }

    // The control: the decision process itself writes this row, twice over.
    const decided = await asTenant(pool, t.orgId, (tx) =>
      recordDecision(tx, { approvalId: opened.approvalId, approver: t.owner, decision: 'APPROVED' }),
    );
    if (!decided.ok) throw new Error(`the legitimate decision was refused: ${decided.code} ${decided.detail}`);
    const status = await pool.query<{ status: string }>(
      `SELECT status FROM ari.approval_requests WHERE id = $1`,
      [opened.approvalId],
    );
    expect(status.rows[0]?.status).toBe('GRANTED');
  });
});

describe('a vote names an authority the database can check', () => {
  it('refuses a role the request never asked for', async () => {
    const t = await fixture();
    const opened = await openApproval(t);
    await expect(forged(t, opened.approvalId, { role: 'viewer' })).rejects.toThrow(/not ask for|asks for/);
  });

  it('refuses a role the approver does not hold in this organisation', async () => {
    const t = await fixture();
    const opened = await openApproval(t);
    // A real user, a role the request does want, and no membership behind it.
    const stranger = await asTenant(pool, t.orgId, (tx) =>
      createUser(tx, { email: 's@x.test', displayName: 'S', role: 'viewer', grantedBy: 'system' }),
    );
    await expect(forged(t, opened.approvalId, { approver: stranger, role: 'owner' })).rejects.toThrow(
      /does not hold owner/,
    );
  });

  it('refuses bytes that are not the ones requested', async () => {
    const t = await fixture();
    const opened = await openApproval(t);
    await expect(forged(t, opened.approvalId, { digest: OTHER })).rejects.toThrow(/other than the request/);
  });

  it('refuses a vote on a decision already made', async () => {
    const t = await fixture();
    const opened = await openApproval(t);
    await asTenant(pool, t.orgId, (tx) =>
      recordDecision(tx, { approvalId: opened.approvalId, approver: t.owner, decision: 'APPROVED' }),
    );
    // Quorum 1 is reached, so the request is GRANTED; a second vote joins nothing, and the
    // count that drives `GRANTED` is the thing a filler row would corrupt.
    await expect(forged(t, opened.approvalId, {})).rejects.toThrow(/does not join a decision/);
  });

  it('refuses the proposer approving their own authority change (T19)', async () => {
    const t = await fixture();
    const opened = await asTenant(pool, t.orgId, (tx) =>
      requestApproval(tx, {
        subjectKind: 'policy_activation',
        subjectId: newId('pol'),
        requestId: newId('req'),
        digest: DIGEST,
        policyVersionId: newId('ppv'),
        agentId: t.agentId,
        walletId: t.walletId,
        amountRaw: null,
        currencyUnit: 'usdc-6dp',
        quorumNeeded: 2,
        allowedRoles: ['owner'],
        requestedBy: t.owner,
        ttlMs: 900_000n,
        key: KEY,
      }),
    );
    await expect(
      pool.query(
        `INSERT INTO ari.approvals (id, approval_request_id, org_id, approver_user_id, role, decision, digest)
         VALUES ($1,$2,$3,$4,'owner','APPROVED',$5)`,
        [newId('apr'), opened.approvalId, t.orgId, t.owner, DIGEST],
      ),
    ).rejects.toThrow(/cannot be its approver/);

    // Control: a *different* owner-role member may, which is the whole point of the rule.
    const peer = await asTenant(pool, t.orgId, (tx) =>
      createUser(tx, { email: 'p@x.test', displayName: 'P', role: 'owner', grantedBy: 'system' }),
    );
    const vote = await pool.query(
      `INSERT INTO ari.approvals (id, approval_request_id, org_id, approver_user_id, role, decision, digest)
       VALUES ($1,$2,$3,$4,'owner','APPROVED',$5) RETURNING id`,
      [newId('apr'), opened.approvalId, t.orgId, peer, DIGEST],
    );
    expect(vote.rowCount).toBe(1);
  });

  it('refuses a vote from a person who is not in the database at all', async () => {
    const t = await fixture();
    const opened = await openApproval(t);
    // Whichever of the two refuses it, the vote does not land — and the trigger's sentence
    // arrives first because a BEFORE trigger runs before referential checks, which is the
    // better of the two messages for whoever reads it in a log.
    await expect(forged(t, opened.approvalId, { approver: newId('usr') })).rejects.toThrow(
      /does not hold owner|violates foreign key constraint/,
    );
  });
});

describe('a window is described by its dimension', () => {
  const key = () => ({
    orgId: newId('org'),
    agentId: newId('agt'),
    windowKey: '2026-09',
    dimension: 'monthly_raw',
  });

  it('refuses a month keyed by a day, on both tables', async () => {
    for (const mismatch of [
      { dimension: 'monthly_raw', window_key: '2026-10-05' },
      { dimension: 'daily_raw', window_key: '2026-10' },
      { dimension: 'daily_usdc-6dp', window_key: '2026-10' },
    ]) {
      await expect(
        pool.query(
          `INSERT INTO ari.limit_counters (org_id, agent_id, window_key, dimension, current_reserved)
           VALUES ($1,$2,$3,$4,0)`,
          [newId('org'), newId('agt'), mismatch.window_key, mismatch.dimension],
        ),
        `${mismatch.dimension} should not accept a key shaped like ${mismatch.window_key}`,
      ).rejects.toThrow(/window_matches_dimension|check constraint/);
    }
  });

  it('accepts the pairs the application actually writes', async () => {
    const k = key();
    await pool.query(
      `INSERT INTO ari.limit_counters (org_id, agent_id, window_key, dimension, current_reserved)
       VALUES ($1,$2,$3,$4,0)`,
      [k.orgId, k.agentId, k.windowKey, k.dimension],
    );
    await pool.query(
      `INSERT INTO ari.limit_counters (org_id, agent_id, window_key, dimension, current_reserved)
       VALUES ($1,$2,$3,$4,0)`,
      [k.orgId, k.agentId, '2026-10-05', 'daily_usdc-6dp'],
    );
  });
});

describe('an approval can record that no amount is involved', () => {
  it('persists a null amount, because zero is a different fact', async () => {
    // `011` allowed the null and `006` forbade it, so this is the test for the gap between
    // a migration's CHECK and the column it sits on: a valueless contract call escalated to
    // a human used to raise a not-null violation inside the authorization transaction — a
    // 500, no decision row, no audit event, for the one candidate shape that genuinely has
    // no amount to show.
    const t = await fixture();
    const opened = await asTenant(pool, t.orgId, (tx) =>
      requestApproval(tx, {
        subjectKind: 'transaction',
        subjectId: newId('txr'),
        requestId: newId('req'),
        digest: DIGEST,
        policyVersionId: newId('ppv'),
        agentId: t.agentId,
        walletId: t.walletId,
        amountRaw: null,
        currencyUnit: 'usdc-6dp',
        // Quorum 2, so a first decision leaves it open and the second refusal below is
        // refused for the bytes rather than for having arrived after the decision.
        quorumNeeded: 2,
        allowedRoles: ['owner'],
        requestedBy: t.agentId,
        ttlMs: 900_000n,
        key: KEY,
      }),
    );

    const stored = await pool.query<{ amount_raw: string | null }>(
      `SELECT amount_raw FROM ari.approval_requests WHERE id = $1`,
      [opened.approvalId],
    );
    expect(stored.rows[0]?.amount_raw).toBeNull();

    // And the vote still validates against it: `null` is not a licence to skip the checks.
    const decided = await asTenant(pool, t.orgId, (tx) =>
      recordDecision(tx, { approvalId: opened.approvalId, approver: t.owner, decision: 'APPROVED' }),
    );
    expect(decided.ok === true && decided.status === 'PENDING').toBe(true);
    await expect(
      forged(t, opened.approvalId, { digest: OTHER }),
      'a valueless approval accepted a vote on different bytes',
    ).rejects.toThrow(/other than the request/);
  });
});

describe('one person holds one role in an organisation', () => {
  it('refuses a second role, because every reader takes the first row it sees', async () => {
    const t = await fixture();
    await expect(
      pool.query(`INSERT INTO ari.memberships (user_id, org_id, role, granted_by) VALUES ($1,$2,'admin','x')`, [
        t.owner,
        t.orgId,
      ]),
    ).rejects.toThrow(/violates unique constraint|memberships_one_role_per_org/);

    // And the legitimate move — changing the role — still works, which is what makes the
    // above a constraint rather than a deadlock on the table.
    await pool.query(`UPDATE ari.memberships SET role = 'admin' WHERE user_id = $1 AND org_id = $2`, [
      t.owner,
      t.orgId,
    ]);
    const roles = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ari.memberships WHERE user_id = $1 AND org_id = $2`,
      [t.owner, t.orgId],
    );
    expect(roles.rows[0]?.count).toBe('1');
  });
});

describe('a published policy does not come back unexplained', () => {
  const JUSTIFIED = 'rollback to the pre-incident document, approved by ops';

  it('refuses a reactivation with no justification, including from SQL', async () => {
    const orgId = newId('org');
    // Two versions, activated and superseded by hand: the state a reactivation starts from.
    const ids = [newId('ppv'), newId('ppv')];
    await pool.query(`INSERT INTO ari.organizations (id, name) VALUES ($1, 'Reactivation')`, [orgId]);
    await pool.query(
      `INSERT INTO ari.policies (id, org_id, name, created_by) VALUES ($1,$2,'immutability','system')`,
      [newId('pol'), orgId],
    );

    // The assertion that matters is about the *table*, so the fixture stays inside it:
    // reach a SUPERSEDED row through the status machine and try to walk it back.
    const policy = await pool.query<{ id: string }>(
      `SELECT id FROM ari.policies WHERE org_id = $1 LIMIT 1`,
      [orgId],
    );
    const policyId = policy.rows[0]?.id;
    if (policyId === undefined) throw new Error('the policy fixture did not land');

    await pool.query(
      `INSERT INTO ari.policy_versions (id, policy_id, org_id, version_number, document, status, created_by, justification)
       VALUES ($1,$2,$3,1,'{}'::jsonb,'DRAFT','system',null), ($4,$2,$3,2,'{}'::jsonb,'DRAFT','system',null)`,
      [ids[0], policyId, orgId, ids[1]],
    );
    await pool.query(`UPDATE ari.policy_versions SET status = 'ACTIVE' WHERE id = $1`, [ids[0]]);
    await pool.query(`UPDATE ari.policy_versions SET status = 'SUPERSEDED' WHERE id = $1`, [ids[0]]);

    await expect(
      pool.query(`UPDATE ari.policy_versions SET status = 'ACTIVE' WHERE id = $1`, [ids[0]]),
    ).rejects.toThrow(/written justification is required/);

    await pool.query(
      `UPDATE ari.policy_versions SET status = 'ACTIVE', justification = $2 WHERE id = $1`,
      [ids[0], JUSTIFIED],
    );
    const back = await pool.query<{ status: string }>(`SELECT status FROM ari.policy_versions WHERE id = $1`, [ids[0]]);
    expect(back.rows[0]?.status).toBe('ACTIVE');

    // A first activation still needs nothing: the floor is about a document *returning*, not
    // about a document arriving. The incumbent has to step down first — one ACTIVE version
    // per policy is a partial unique index in `005`, and this is the third time in this file
    // that an existing rule has corrected a test rather than the reverse.
    await pool.query(
      `UPDATE ari.policy_versions SET status = 'SUPERSEDED', justification = $2 WHERE id = $1`,
      [ids[0], JUSTIFIED],
    );
    await pool.query(`UPDATE ari.policy_versions SET status = 'ACTIVE' WHERE id = $1`, [ids[1]]);
    expect((await pool.query<{ status: string }>(`SELECT status FROM ari.policy_versions WHERE id = $1`, [ids[1]])).rows[0]?.status).toBe(
      'ACTIVE',
    );
  });
});
