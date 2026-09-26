/**
 * Policy versioning and the activation guard (S9, §7.3, T6, T7).
 *
 * The premise of this suite is that loosening a rule is the cheap attack on an
 * authorization system — cheaper than forging anything, and invisible unless the
 * comparison is made explicitly. So the tests are mostly about who may move a
 * boundary outward, and about whether a published rule can be edited after the
 * fact.
 */

import { newId } from '@ari/schemas';
import type { PolicyDocument } from '@ari/schemas';
import { createOrganization, createUser, asTenant, type Connector } from '@ari/identity';
import {
  ActivationRefused,
  activateRefusing,
  activateVersion,
  activeVersion,
  createPolicy,
  listVersions,
  proposeVersion,
} from '@ari/policies';
import { verifyChain } from '@ari/audit';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './database.js';

let pool: Pool;
/**
 * A second pool for the `ari_app` connections.
 *
 * The same pool cannot serve both: a released client returns to the queue still
 * holding the role it assumed, and the next `pool.query` — which is meant to be the
 * table owner, bypassing row security — silently inherits it. That produced an
 * UPDATE matching zero rows and no error, which is the worst possible failure shape
 * for a test of an isolation rule.
 */
let appPool: Pool;
const app: Connector = {
  async connect(): Promise<PoolClient> {
    const client = await appPool.connect();
    await client.query(`SET ROLE ari_app`);
    return client;
  },
};

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const NOVEL = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';
const UNIT = 'usdc-6dp';

beforeAll(async () => {
  pool = await connect();
  appPool = await connect(4);
});

afterAll(async () => {
  await appPool?.end();
  await pool?.end();
});

function document(overrides: {
  readonly perTransaction?: bigint;
  readonly perDay?: bigint;
  readonly recipients?: readonly string[];
  readonly chains?: readonly ('ethereum' | 'bitcoin')[];
  readonly newRecipients?: boolean;
  readonly escalationRules?: number;
} = {}): PolicyDocument {
  return {
    meta: { name: 'accounts-payable', description: null },
    target: {
      walletId: newId('wal'),
      authorityMode: 'user_gated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
    },
    permissions: {
      transfers: {
        enabled: true,
        chains: [...(overrides.chains ?? ['ethereum'])],
        // `decimals` is a bigint on the parsed type — SmallCount accepts a JSON
        // integer on the way in and widens it, because the canonical encoder
        // refuses numbers outright.
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6n }],
        recipients: { mode: 'allowlist', addresses: [...(overrides.recipients ?? [RECIPIENT])] },
        perTransaction: { maxRaw: (overrides.perTransaction ?? 2_000_000_000n).toString(), unit: UNIT },
        perDay: { maxRaw: (overrides.perDay ?? 25_000_000_000n).toString(), unit: UNIT },
        perMonth: { maxRaw: '200000000000', unit: UNIT },
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: overrides.newRecipients ?? false, requireApproval: true },
    },
    escalation: {
      humanApproval: {
        requiredWhen:
          (overrides.escalationRules ?? 1) === 0
            ? []
            : [{ op: 'amount_gt', raw: '1000000000', unit: UNIT }],
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
  };
}

/** A tenant with an owner, an admin, a viewer, and one policy already active. */
async function fixture() {
  const orgId = await createOrganization(app, { name: 'Policies', bootstrapActor: 'system' });
  const people = await asTenant(app, orgId, async (tx) => ({
    owner: await createUser(tx, { email: 'o@p.test', displayName: 'O', role: 'owner', grantedBy: 'system' }),
    admin: await createUser(tx, { email: 'a@p.test', displayName: 'A', role: 'admin', grantedBy: 'system' }),
    viewer: await createUser(tx, { email: 'v@p.test', displayName: 'V', role: 'viewer', grantedBy: 'system' }),
  }));
  const created = await asTenant(app, orgId, (tx) =>
    createPolicy(tx, { name: 'accounts-payable', document: document(), actor: people.owner }),
  );
  await asTenant(app, orgId, (tx) =>
    activateVersion(tx, { policyId: created.policyId, versionId: created.versionId, actor: people.owner }),
  );
  return { orgId, ...people, ...created };
}

async function events(orgId: string, eventType: string) {
  return pool.query<{ severity: string; metadata: Record<string, string>; reason_codes: string[] }>(
    `SELECT severity, metadata, reason_codes FROM ari.audit_events WHERE org_id = $1 AND event_type = $2`,
    [orgId, eventType],
  );
}

describe('proposal and activation', () => {
  it('creates a draft that governs nothing until it is activated', async () => {
    const orgId = await createOrganization(app, { name: 'Draft', bootstrapActor: 'system' });
    const owner = await asTenant(app, orgId, (tx) =>
      createUser(tx, { email: 'd@p.test', displayName: 'D', role: 'owner', grantedBy: 'system' }),
    );
    const created = await asTenant(app, orgId, (tx) =>
      createPolicy(tx, { name: 'unactivated', document: document(), actor: owner }),
    );

    const versions = await asTenant(app, orgId, (tx) => listVersions(tx, created.policyId));
    expect(versions.map((version) => version.status)).toEqual(['DRAFT']);
    // Nothing is in force, so a request against this policy has no version to be
    // evaluated under — the state that "we created the policy" must not pretend is
    // the same as "we are enforcing it".
    expect(await asTenant(app, orgId, (tx) => activeVersion(tx, created.policyId))).toBeNull();
  });

  it('activates the first version and records the transition', async () => {
    const f = await fixture();
    const active = await asTenant(app, f.orgId, (tx) => activeVersion(tx, f.policyId));
    expect(active?.versionNumber).toBe(1);
    expect(active?.status).toBe('ACTIVE');
    const activated = await events(f.orgId, 'policy.activated');
    expect(activated.rows[0]?.severity).toBe('info');
    expect(activated.rows[0]?.metadata.versionTo).toBe('1');
  });

  it('refuses a document whose limits disagree on units, at proposal', async () => {
    const f = await fixture();
    const broken = { ...document(), permissions: { ...document().permissions } };
    broken.permissions.transfers = {
      ...broken.permissions.transfers,
      perDay: { maxRaw: '99000000000', unit: 'usdc-8dp' },
    };
    await expect(
      asTenant(app, f.orgId, (tx) => proposeVersion(tx, { policyId: f.policyId, document: broken, actor: f.owner })),
    ).rejects.toThrow(/share a unit/);
    // Nothing was left behind, so the failed proposal cannot be activated later.
    const versions = await asTenant(app, f.orgId, (tx) => listVersions(tx, f.policyId));
    expect(versions).toHaveLength(1);
  });
});

describe('the broadening guard', () => {
  it('refuses an admin raising a ceiling, and names the dimension', async () => {
    const f = await fixture();
    const wider = await asTenant(app, f.orgId, (tx) =>
      proposeVersion(tx, { policyId: f.policyId, document: document({ perTransaction: 5_000_000_000n }), actor: f.admin }),
    );

    let refusal: ActivationRefused | null = null;
    try {
      await activateRefusing(app, f.orgId, { policyId: f.policyId, versionId: wider.versionId, actor: f.admin });
    } catch (error) {
      refusal = error as ActivationRefused;
    }
    expect(refusal?.code).toBe('APPROVER_NOT_AUTHORISED');
    expect(refusal?.widening.map((change) => change.dimension)).toContain(
      'permissions.transfers.perTransaction',
    );

    const refused = await events(f.orgId, 'policy.activation_refused');
    expect(refused.rows[0]?.severity).toBe('critical');
    expect(refused.rows[0]?.reason_codes).toContain('APPROVER_NOT_AUTHORISED');

    // The refusal rolled the transaction back, so v1 still governs and v2 is a
    // draft rather than a half-activated policy.
    const active = await asTenant(app, f.orgId, (tx) => activeVersion(tx, f.policyId));
    expect(active?.versionNumber).toBe(1);
  });

  it('lets the owner make the same change, and records it as a widening', async () => {
    const f = await fixture();
    const wider = await asTenant(app, f.orgId, (tx) =>
      proposeVersion(tx, { policyId: f.policyId, document: document({ perTransaction: 5_000_000_000n }), actor: f.owner }),
    );
    const result = await asTenant(app, f.orgId, (tx) =>
      activateVersion(tx, { policyId: f.policyId, versionId: wider.versionId, actor: f.owner }),
    );
    expect(result.widened).toBe(true);
    expect(result.previousVersionId).not.toBeNull();

    const broadened = await events(f.orgId, 'policy.broadened');
    expect(broadened.rows[0]?.severity).toBe('critical');
    expect(broadened.rows[0]?.metadata.detail).toContain('perTransaction');

    const statuses = (await asTenant(app, f.orgId, (tx) => listVersions(tx, f.policyId))).map((v) => v.status);
    expect(statuses).toEqual(['SUPERSEDED', 'ACTIVE']);
  });

  it('treats a wider allowlist, a new chain and an enabled capability as widenings too', async () => {
    const f = await fixture();
    const cases = [
      document({ recipients: [RECIPIENT, NOVEL] }),
      document({ chains: ['ethereum', 'bitcoin'] }),
      document({ newRecipients: true }),
      document({ escalationRules: 0 }),
    ];
    for (const [index, candidate] of cases.entries()) {
      const proposed = await asTenant(app, f.orgId, (tx) =>
        proposeVersion(tx, { policyId: f.policyId, document: candidate, actor: f.admin }),
      );
      await expect(
        activateRefusing(app, f.orgId, { policyId: f.policyId, versionId: proposed.versionId, actor: f.admin }),
      ).rejects.toBeInstanceOf(ActivationRefused);
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it('lets an admin narrow a policy without an owner', async () => {
    const f = await fixture();
    const tighter = await asTenant(app, f.orgId, (tx) =>
      proposeVersion(tx, {
        policyId: f.policyId,
        document: document({ perTransaction: 1_000_000_000n, perDay: 5_000_000_000n }),
        actor: f.admin,
      }),
    );
    const result = await asTenant(app, f.orgId, (tx) =>
      activateVersion(tx, { policyId: f.policyId, versionId: tighter.versionId, actor: f.admin }),
    );
    expect(result.widened).toBe(false);
    expect(result.widenings).toEqual([]);
    expect((await events(f.orgId, 'policy.broadened')).rowCount).toBe(0);
  });

  it('refuses a viewer outright, before any comparison is made', async () => {
    const f = await fixture();
    await expect(
      activateRefusing(app, f.orgId, { policyId: f.policyId, versionId: f.versionId, actor: f.viewer }),
    ).rejects.toThrow(/cannot activate policies/);
  });
});

describe('rollback is not a neutral act', () => {
  it('requires a written justification to go back to an older version', async () => {
    const f = await fixture();
    const v2 = await asTenant(app, f.orgId, (tx) =>
      proposeVersion(tx, { policyId: f.policyId, document: document({ perDay: 30_000_000_000n }), actor: f.owner }),
    );
    await asTenant(app, f.orgId, (tx) =>
      activateVersion(tx, { policyId: f.policyId, versionId: v2.versionId, actor: f.owner }),
    );

    await expect(
      activateRefusing(app, f.orgId, { policyId: f.policyId, versionId: f.versionId, actor: f.owner }),
    ).rejects.toThrow(/written justification/);

    const back = await asTenant(app, f.orgId, (tx) =>
      activateVersion(tx, {
        policyId: f.policyId,
        versionId: f.versionId,
        actor: f.owner,
        justification: 'v2 raised the daily cap for a vendor prepayment that was cancelled',
      }),
    );
    expect(back.versionNumber).toBe(1);
    const stored = await pool.query<{ justification: string }>(
      `SELECT justification FROM ari.policy_versions WHERE id = $1`,
      [f.versionId],
    );
    expect(stored.rows[0]?.justification).toContain('cancelled');
    expect((await events(f.orgId, 'policy.activated')).rows.at(-1)?.severity).toBe('warning');
  });

  it('is idempotent for the version already active', async () => {
    const f = await fixture();
    const again = await asTenant(app, f.orgId, (tx) =>
      activateVersion(tx, { policyId: f.policyId, versionId: f.versionId, actor: f.owner }),
    );
    expect(again.widened).toBe(false);
    expect((await asTenant(app, f.orgId, (tx) => activeVersion(tx, f.policyId)))?.versionNumber).toBe(1);
  });
});

describe('what the database will not do', () => {
  it('refuses to edit a published version’s content', async () => {
    const f = await fixture();
    await expect(
      pool.query(`UPDATE ari.policy_versions SET document = document || '{"meta":{"name":"quietly-looser"}}'::jsonb WHERE id = $1`, [
        f.versionId,
      ]),
    ).rejects.toThrow(/content is immutable/);

    // A status change is the same row's only permitted edit, which is what makes
    // activation possible without making it editable.
    await pool.query(`UPDATE ari.policy_versions SET status = 'RETIRED', activated_at = now() WHERE id = $1`, [
      f.versionId,
    ]);
    const row = await pool.query<{ status: string }>(`SELECT status FROM ari.policy_versions WHERE id = $1`, [
      f.versionId,
    ]);
    expect(row.rows[0]?.status).toBe('RETIRED');
  });

  it('keeps exactly one version active even when asked twice', async () => {
    const f = await fixture();
    const v2 = await asTenant(app, f.orgId, (tx) =>
      proposeVersion(tx, { policyId: f.policyId, document: document({ perDay: 30_000_000_000n }), actor: f.owner }),
    );
    await expect(
      pool.query(
        `UPDATE ari.policy_versions SET status = 'ACTIVE' WHERE policy_id = $1`,
        [f.policyId],
      ),
    ).rejects.toThrow(/unique|duplicate key/);
    expect(v2.versionNumber).toBe(2);
  });

  it('will not let another organisation activate or even see the policy', async () => {
    const f = await fixture();
    const otherOrgId = await createOrganization(app, { name: 'Other', bootstrapActor: 'system' });
    const other = await asTenant(app, otherOrgId, async (tx) => ({
      owner: await createUser(tx, { email: 'o@o.test', displayName: 'O', role: 'owner', grantedBy: 'system' }),
    }));

    await expect(
      asTenant(app, otherOrgId, (tx) =>
        activateVersion(tx, { policyId: f.policyId, versionId: f.versionId, actor: other.owner }),
      ),
    ).rejects.toThrow(/not in this organisation/);

    const peek = await asTenant(app, otherOrgId, (tx) =>
      tx.client.query(`SELECT id FROM ari.policy_versions WHERE org_id = $1`, [f.orgId]),
    );
    expect(peek.rowCount).toBe(0);
  });

  it('holds the whole chain together afterwards', async () => {
    const f = await fixture();
    const wider = await asTenant(app, f.orgId, (tx) =>
      proposeVersion(tx, { policyId: f.policyId, document: document({ perTransaction: 4_000_000_000n }), actor: f.owner }),
    );
    await asTenant(app, f.orgId, (tx) =>
      activateVersion(tx, { policyId: f.policyId, versionId: wider.versionId, actor: f.owner }),
    );
    const report = await verifyChain(pool, f.orgId);
    expect(report.breaks).toEqual([]);
    expect(report.events).toBeGreaterThan(4);
  });
});
