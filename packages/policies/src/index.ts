/**
 * Policy lifecycle: propose, activate, supersede.
 *
 * §7.3's three rules, and the reason each one is here rather than in a runbook:
 *
 *   - A published version is immutable, so a decision can be re-derived months
 *     later. Enforced by a trigger (`005_policy_versions.sql`), because the
 *     repository being careful is not the same thing as the row refusing.
 *   - Activation is separately authorised, and *who may do it* is read from the
 *     database rather than passed in by the caller. A `requireOwner: boolean`
 *     argument would be an authorisation model where the client decides.
 *   - Broadening requires an owner, and a rollback to an older version needs a
 *     written justification — because the cheapest attack on this system is not
 *     forging a signature, it is quietly loosening the rule that gates it (T6, T7).
 */

import { appendEvent } from '@ari/audit';
import { compilePolicy, type CompiledPolicy } from '@ari/policy-engine';
import { asTenant, type Connector, type TenantTx } from '@ari/identity';
import { newId, type PolicyDocument as Document } from '@ari/schemas';
import {
  breadthOf,
  parseDocument,
  serializeDocument,
  widenings,
  type Breadth,
  type Widening,
} from './breadth.js';

export interface StoredVersion {
  readonly id: string;
  readonly policyId: string;
  readonly orgId: string;
  readonly versionNumber: number;
  readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED';
  readonly document: Document;
  readonly breadth: Breadth;
  /**
   * Compiled at load, once, from the immutable document. The pipeline evaluates
   * against this and never against `document` — A4's promise is that nothing on the
   * decision path reads the authoring shape, and holding both on one row is what
   * makes that checkable rather than aspirational.
   */
  readonly compiled: CompiledPolicy;
  readonly justification: string | null;
}

export class ActivationRefused extends Error {
  constructor(
    readonly code: 'APPROVER_NOT_AUTHORISED' | 'JUSTIFICATION_REQUIRED' | 'INTERNAL_ERROR_FAIL_CLOSED',
    readonly detail: string,
    readonly widening: readonly Widening[],
    readonly context: { readonly orgId: string; readonly actor: string; readonly versionId: string },
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ActivationRefused';
  }
}

async function roleOf(tx: TenantTx, userId: string): Promise<string | null> {
  const rows = await tx.client.query<{ role: string }>(
    `SELECT role FROM ari.memberships WHERE user_id = $1 AND org_id = $2`,
    [userId, tx.orgId],
  );
  return rows.rows[0]?.role ?? null;
}

/** Public: the authorization pipeline resolves an agent's grant to exactly one of these. */
export async function loadVersion(tx: TenantTx, versionId: string): Promise<StoredVersion | null> {
  const rows = await tx.client.query<{
    id: string;
    policy_id: string;
    org_id: string;
    version_number: number;
    status: StoredVersion['status'];
    document: unknown;
    justification: string | null;
  }>(
    `SELECT id, policy_id, org_id, version_number, status, document, justification
       FROM ari.policy_versions WHERE id = $1 AND org_id = $2`,
    [versionId, tx.orgId],
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  const document = parseDocument(row.document);
  const compiled = compilePolicy(document, {
    policyId: row.policy_id,
    versionId: row.id,
    versionNumber: row.version_number,
  });
  return {
    id: row.id,
    policyId: row.policy_id,
    orgId: row.org_id,
    versionNumber: row.version_number,
    status: row.status,
    document,
    breadth: breadthOf(compiled),
    compiled,
    justification: row.justification,
  };
}

export async function activeVersion(tx: TenantTx, policyId: string): Promise<StoredVersion | null> {
  const rows = await tx.client.query<{ id: string }>(
    `SELECT id FROM ari.policy_versions WHERE policy_id = $1 AND org_id = $2 AND status = 'ACTIVE'`,
    [policyId, tx.orgId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : loadVersion(tx, row.id);
}

export async function listVersions(tx: TenantTx, policyId: string): Promise<readonly StoredVersion[]> {
  const rows = await tx.client.query<{ id: string }>(
    `SELECT id FROM ari.policy_versions WHERE policy_id = $1 AND org_id = $2 ORDER BY version_number`,
    [policyId, tx.orgId],
  );
  const versions: StoredVersion[] = [];
  for (const row of rows.rows) {
    const version = await loadVersion(tx, row.id);
    if (version !== null) versions.push(version);
  }
  return versions;
}

/**
 * Create a policy and its first version. The first version is a draft, never
 * silently live: "the policy exists" and "the policy governs money" are two events
 * and they have two timestamps.
 */
/**
 * Every function here takes the acting human explicitly.
 *
 * Not carried on the tenant handle, because the handle is opened by code that has
 * no idea who is asking — a background worker and an authenticated request look the
 * same from there. Attribution is a claim the caller has to make, and `roleOf` is
 * what checks it against the database rather than against the claim.
 */
export async function createPolicy(
  tx: TenantTx,
  input: { readonly name: string; readonly document: Document; readonly actor: string },
): Promise<{ readonly policyId: string; readonly versionId: string; readonly versionNumber: number }> {
  const document = parseDocument(input.document);
  const policyId = newId('pol');
  const versionId = newId('ppv');
  // Compiling here is validation, not preparation: a document whose limits disagree
  // on units fails at proposal, where someone is holding it, rather than at the
  // activation that would have been the first time anything read it.
  compilePolicy(document, { policyId, versionId, versionNumber: 1 });

  await tx.client.query(
    `INSERT INTO ari.policies (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)`,
    [policyId, tx.orgId, input.name, input.actor],
  );
  await tx.client.query(
    `INSERT INTO ari.policy_versions (id, policy_id, org_id, version_number, document, status, created_by)
     VALUES ($1, $2, $3, 1, $4::jsonb, 'DRAFT', $5)`,
    [versionId, policyId, tx.orgId, serializeDocument(document), input.actor],
  );
  await appendEvent(tx, {
    orgId: tx.orgId,
    actor: input.actor,
    actorType: 'human',
    eventType: 'policy.created',
    resource: 'policy_version',
    resourceId: versionId,
    policyVersionId: versionId,
    metadata: { policyName: input.name, versionTo: '1' },
  });
  return { policyId, versionId, versionNumber: 1 };
}

export async function proposeVersion(
  tx: TenantTx,
  input: { readonly policyId: string; readonly document: Document; readonly actor: string },
): Promise<{ readonly versionId: string; readonly versionNumber: number }> {
  const document = parseDocument(input.document);
  const next = await tx.client.query<{ version_number: number }>(
    `SELECT coalesce(max(version_number), 0) + 1 AS version_number FROM ari.policy_versions
      WHERE policy_id = $1 AND org_id = $2`,
    [input.policyId, tx.orgId],
  );
  const versionNumber = next.rows[0]?.version_number ?? 1;
  const versionId = newId('ppv');
  compilePolicy(document, { policyId: input.policyId, versionId, versionNumber });

  await tx.client.query(
    `INSERT INTO ari.policy_versions (id, policy_id, org_id, version_number, document, status, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'DRAFT', $6)`,
    [versionId, input.policyId, tx.orgId, versionNumber, serializeDocument(document), input.actor],
  );
  await appendEvent(tx, {
    orgId: tx.orgId,
    actor: input.actor,
    actorType: 'human',
    eventType: 'policy.created',
    resource: 'policy_version',
    resourceId: versionId,
    policyVersionId: versionId,
    metadata: { versionTo: String(versionNumber) },
  });
  return { versionId, versionNumber };
}

export interface ActivationResult {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly previousVersionId: string | null;
  readonly widened: boolean;
  readonly widenings: readonly Widening[];
}

/**
 * Make a version the one that governs.
 *
 * The status flip is one transaction: superseding the incumbent and activating the
 * newcomer cannot be observed half-done, and the partial unique index on
 * `status = 'ACTIVE'` means a concurrent activation loses rather than producing two
 * live versions of the same policy.
 */
export async function activateVersion(
  tx: TenantTx,
  input: {
    readonly policyId: string;
    readonly versionId: string;
    readonly actor: string;
    readonly justification?: string;
  },
): Promise<ActivationResult> {
  const context = { orgId: tx.orgId, actor: input.actor, versionId: input.versionId };
  const role = await roleOf(tx, input.actor);
  if (role !== 'owner' && role !== 'admin') {
    refuse(context, 'APPROVER_NOT_AUTHORISED', `role ${role ?? 'none'} cannot activate policies`);
  }

  const target = await loadVersion(tx, input.versionId);
  if (target === null || target.policyId !== input.policyId) {
    refuse(context, 'INTERNAL_ERROR_FAIL_CLOSED', 'version is not in this organisation');
    throw new Error('unreachable');
  }
  if (target.status === 'ACTIVE') {
    // Already live: activating it again is the same request, not a violation, and
    // answering with the current state keeps a retried deploy idempotent.
    return {
      versionId: target.id,
      versionNumber: target.versionNumber,
      previousVersionId: null,
      widened: false,
      widenings: [],
    };
  }

  const incumbent = await activeVersion(tx, input.policyId);
  const changes = incumbent === null ? [] : widenings(incumbent.breadth, target.breadth);
  const isDowngrade = incumbent !== null && target.versionNumber < incumbent.versionNumber;

  // A reactivation always costs a sentence, not only a downgrade. `010`'s machine makes
  // `SUPERSEDED → ACTIVE` the one step that reads backwards, and the case the version-number
  // comparison missed is the worst one: nothing active at all — every version superseded or
  // retired — and an older document returns as the authority on an organisation's money with
  // no reason recorded anywhere. The database now refuses that too (`014`), so the two copies
  // agree on the floor; what neither can express is freshness, and that is said plainly in the
  // migration rather than implied here.
  const isReactivation = target.status === 'SUPERSEDED';
  if ((isDowngrade || isReactivation) && (input.justification === undefined || input.justification.trim().length < 10)) {
    refuse(
      context,
      'JUSTIFICATION_REQUIRED',
      isReactivation
        ? 'reactivating a published version requires a written justification'
        : 'activating an older version than the incumbent requires a written justification',
      changes,
    );
  }
  if (changes.length > 0 && role !== 'owner') {
    refuse(
      context,
      'APPROVER_NOT_AUTHORISED',
      `broadening requires the owner: ${changes.map((change) => change.dimension).join(', ')}`,
      changes,
    );
  }

  if (incumbent !== null) {
    await tx.client.query(`UPDATE ari.policy_versions SET status = 'SUPERSEDED' WHERE id = $1`, [incumbent.id]);
  }
  await tx.client.query(
    `UPDATE ari.policy_versions
        SET status = 'ACTIVE', activated_at = now(), activated_by = $2,
            justification = coalesce($3, justification)
      WHERE id = $1`,
    [target.id, input.actor, input.justification ?? null],
  );

  await appendEvent(tx, {
    orgId: tx.orgId,
    actor: input.actor,
    actorType: 'human',
    eventType: 'policy.activated',
    resource: 'policy_version',
    resourceId: target.id,
    policyVersionId: target.id,
    severity: changes.length > 0 || isDowngrade ? 'warning' : 'info',
    metadata: {
      versionFrom: incumbent === null ? 'none' : String(incumbent.versionNumber),
      versionTo: String(target.versionNumber),
      ...(changes.length > 0 ? { detail: changes.map((change) => `${change.dimension} ${change.from}`).join('; ').slice(0, 500) } : {}),
      ...(isDowngrade ? { reason: 'reactivation of an older version' } : {}),
    },
  });
  if (changes.length > 0) {
    // A separate event, at a separate severity, because "a policy was activated" is
    // routine and "an authority boundary moved outward" is the thing the colony map
    // highlights and the reviewer has to notice.
    await appendEvent(tx, {
      orgId: tx.orgId,
      actor: input.actor,
      actorType: 'human',
      eventType: 'policy.broadened',
      resource: 'policy_version',
      resourceId: target.id,
      policyVersionId: target.id,
      severity: 'critical',
      metadata: { detail: changes.map((change) => change.dimension).join(', ').slice(0, 500) },
    });
  }

  return {
    versionId: target.id,
    versionNumber: target.versionNumber,
    previousVersionId: incumbent?.id ?? null,
    widened: changes.length > 0,
    widenings: changes,
  };
}

/**
 * Refuse, without recording it.
 *
 * The refusal *is* recorded — but by `activateRefusing`, after this transaction has
 * aborted. Writing it here and then throwing was the first design, and it meant the
 * one event an investigator most wants ("someone tried to widen this and was told
 * no") was the one event the rollback erased. Evidence of a refusal cannot live
 * inside the transaction that refuses.
 */
function refuse(
  context: { readonly orgId: string; readonly actor: string; readonly versionId: string },
  code: ActivationRefused['code'],
  detail: string,
  changes: readonly Widening[] = [],
): never {
  throw new ActivationRefused(code, detail, changes, context);
}

/**
 * The pool-level entry point: activate, and if the guard fires, write the refusal in
 * a transaction of its own before rethrowing.
 *
 * Sequencing matters here. A second writer cannot simply record the refusal while
 * the first transaction is still open — `asTenant` takes the organisation's advisory
 * chain lock first, so an independent write from inside it would wait on a lock held
 * by the very transaction waiting for it to finish.
 */
export async function activateRefusing(
  pool: Connector,
  orgId: string,
  input: { readonly policyId: string; readonly versionId: string; readonly actor: string; readonly justification?: string },
): Promise<ActivationResult> {
  try {
    return await asTenant(pool, orgId, (tx) => activateVersion(tx, input));
  } catch (error) {
    if (error instanceof ActivationRefused) {
      await asTenant(pool, orgId, (tx) =>
        appendEvent(tx, {
          orgId,
          actor: error.context.actor,
          actorType: 'human',
          eventType: 'policy.activation_refused',
          resource: 'policy_version',
          resourceId: error.context.versionId,
          severity: 'critical',
          reasonCodes: [error.code],
          metadata: { code: error.code, detail: error.detail.slice(0, 500) },
        }),
      );
    }
    throw error;
  }
}

