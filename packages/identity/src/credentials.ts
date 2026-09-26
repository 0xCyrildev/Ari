/**
 * Agent credentials: mint, present, verify, revoke, rotate (A7, S11, T2, T8).
 *
 * Three separations, each of which is a thing a system in this category gets
 * wrong once:
 *
 *   - **Identity is not the secret.** `keyId` is public and selects which row a
 *     presentation is checked against; `secret` is the only bearer element. That
 *     is what makes rotation, revocation and "which credential issued this
 *     request" expressible at all — a bare bearer token can be revoked, but not
 *     talked about.
 *   - **The pepper is outside the database.** `secret_hash` is Argon2id over
 *     (pepper ‖ secret), where the pepper is derived per organisation from a master
 *     secret that never lives in a table. A stolen table then cannot be tested
 *     against a leaked credential list offline, which is the specific thing T8 is
 *     about: the hash stops recovery of *this* secret, the pepper stops
 *     *correlation* across tenants.
 *   - **A presented credential names its tenant, and that name authorises
 *     nothing.** Authentication happens before a tenant is known, so the org
 *     segment picks which bucket to look in. Presenting another organisation's
 *     bucket with a real secret still fails, because the row is not there and the
 *     pepper would be wrong anyway.
 */

import { newId } from '@ari/schemas';
import { appendEvent } from '@ari/audit';
import { hash, verify } from '@node-rs/argon2';
import { createHmac, randomBytes } from 'node:crypto';
import type { Scope } from './tenant.js';
import { asTenant, type Connector, type TenantTx } from './tenant.js';

/** `crd_<uuidv7>.<43-char secret>` — the wire form an agent presents. */
export interface PresentedCredential {
  readonly orgId: string;
  readonly keyId: string;
  readonly secret: string;
}

export interface IssuedCredential {
  readonly credentialId: string;
  readonly presented: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: string;
}

export type CredentialFailure =
  | 'AGENT_NOT_FOUND'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_REVOKED'
  | 'AGENT_REVOKED'
  | 'AGENT_PAUSED'
  | 'ORGANIZATION_MISMATCH';

export type CredentialResult =
  | {
      readonly ok: true;
      readonly orgId: string;
      readonly agentId: string;
      readonly credentialId: string;
      readonly scopes: readonly Scope[];
    }
  | { readonly ok: false; readonly reason: CredentialFailure };

/**
 * The per-organisation pepper.
 *
 * One master secret in configuration, one derived value per tenant: an attacker
 * who reads the database and the configuration gets every pepper, and an attacker
 * who reads only the database gets none — which is the whole point, since T8's
 * scenario is a leaked replica, not a total compromise.
 */
export function pepperFor(master: string, orgId: string): string {
  if (master.length < 32) {
    throw new RangeError('CREDENTIAL_PEPPER must be at least 32 characters');
  }
  return createHmac('sha256', master).update(orgId).digest('hex');
}

function salted(master: string, orgId: string, secret: string): string {
  return `${pepperFor(master, orgId)}:${secret}`;
}

export function parsePresented(value: string): PresentedCredential | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [orgId, keyId, secret] = parts as [string, string, string];
  if (!orgId.startsWith('org_') || !keyId.startsWith('crd_') || secret.length < 20) return null;
  return { orgId, keyId, secret };
}

/**
 * Mint a credential. The returned `presented` string is the only time the secret
 * exists anywhere other than in this call — the row holds a digest.
 */
export async function issueCredential(
  tx: TenantTx,
  input: {
    readonly agentId: string;
    readonly scopes: readonly Scope[];
    readonly ttlMs: bigint;
    readonly masterPepper: string;
    readonly actor: string;
    readonly rotationOf?: string;
  },
): Promise<IssuedCredential> {
  if (input.scopes.length === 0) {
    throw new RangeError('a credential with no scopes is not a credential, it is a typo');
  }
  if (input.ttlMs <= 0n) {
    throw new RangeError('credentials expire; pass a positive ttl');
  }
  const keyId = newId('crd');
  const secret = randomBytes(32).toString('base64url');
  // `hash()` is Argon2id in this binding, and the assertion in the test suite is
  // what keeps that from becoming a claim about a default someone changed: a silent
  // fall back to Argon2i or Argon2d would be an S11 regression nobody would notice
  // until a credential table leaked.
  const secretHash = await hash(salted(input.masterPepper, tx.orgId, secret));
  const expiresAt = new Date(Number(tx.startedAtMs) + Number(input.ttlMs)).toISOString();

  await tx.client.query(
    `INSERT INTO ari.agent_credentials
       (id, org_id, agent_id, key_id, secret_hash, scopes, expires_at, rotation_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [keyId, tx.orgId, input.agentId, keyId, secretHash, [...input.scopes], expiresAt, input.rotationOf ?? null],
  );

  // The event names the credential and its scopes; never the secret, and never a
  // value derived from it that an attacker could replay. `credentialId` is the
  // public half of the pair, so this is a reference and not a leak.
  await appendEvent(tx, {
    orgId: tx.orgId,
    actor: input.actor,
    actorType: 'human',
    eventType: input.rotationOf === undefined ? 'credential.issued' : 'credential.rotated',
    resource: 'credential',
    resourceId: keyId,
    severity: 'notice',
    metadata: {
      credentialId: keyId,
      ...(input.rotationOf === undefined ? {} : { keyId: input.rotationOf }),
    },
  });

  return {
    credentialId: keyId,
    presented: `${tx.orgId}.${keyId}.${secret}`,
    scopes: input.scopes,
    expiresAt,
  };
}

interface CredentialRow {
  readonly id: string;
  readonly org_id: string;
  readonly agent_id: string;
  readonly secret_hash: string;
  readonly scopes: string[];
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly agent_status: string;
}

/**
 * Verify a presented credential, with no tenant assumed and no row leaked either
 * way: an unknown `keyId` and a wrong secret produce the same refusal, so the
 * endpoint cannot be used to enumerate which agents exist (T8's enumeration half).
 */
export async function verifyCredential(
  pool: Connector,
  presented: string,
  masterPepper: string,
  nowMs: () => bigint,
): Promise<CredentialResult> {
  const parsed = parsePresented(presented);
  if (parsed === null) return { ok: false, reason: 'AGENT_NOT_FOUND' };

  // Authentication cannot be tenant-scoped, because finding the row is how the
  // tenant becomes known — and the row policies below it refuse an unscoped read on
  // purpose, so an unset tenant never silently sees everything. The one exception is
  // `ari.credential_lookup`, a view that exposes only the fields the check needs and
  // no names. It exists because the secret it hands back is already peppered and
  // Argon2id-hashed, which is the mitigation for reading it across tenants (T8).
  const client = await pool.connect();
  let row: CredentialRow | undefined;
  try {
    const found = await client.query<CredentialRow>(
      `SELECT id, org_id, agent_id, secret_hash, scopes, expires_at, revoked_at, agent_status
         FROM ari.credential_lookup
        WHERE key_id = $1`,
      [parsed.keyId],
    );
    row = found.rows[0];
  } finally {
    client.release();
  }

  if (row === undefined || row.org_id !== parsed.orgId) {
    // Same refusal as a bad secret, and the same cost: the pepper for a *claimed*
    // org is hashed even when no row matched, so a miss does not answer faster
    // than a hit.
    await hash(salted(masterPepper, parsed.orgId, parsed.secret));
    return { ok: false, reason: 'AGENT_NOT_FOUND' };
  }

  const secretMatches = await verify(
    row.secret_hash,
    salted(masterPepper, row.org_id, parsed.secret),
  ).catch(() => false);
  if (!secretMatches) return { ok: false, reason: 'AGENT_NOT_FOUND' };

  if (row.agent_status === 'REVOKED') return { ok: false, reason: 'AGENT_REVOKED' };
  if (row.agent_status === 'PAUSED') return { ok: false, reason: 'AGENT_PAUSED' };
  if (row.revoked_at !== null && row.revoked_at.getTime() <= Number(nowMs())) {
    return { ok: false, reason: 'CREDENTIAL_REVOKED' };
  }
  if (row.expires_at.getTime() <= Number(nowMs())) return { ok: false, reason: 'CREDENTIAL_EXPIRED' };

  return {
    ok: true,
    orgId: row.org_id,
    agentId: row.agent_id,
    credentialId: row.id,
    scopes: row.scopes as Scope[],
  };
}

/**
 * Revoke, and report what is still live for that agent.
 *
 * The database dates the revocation (`revoked_at = now()`), not the caller.
 * `004_identity.sql` enforces `revoked_at > created_at`, and `created_at` is the
 * database's clock — so a caller-supplied time is a second clock standing in the way
 * of an ordinary, correct operation: a service whose clock runs half a second behind
 * cannot revoke a credential it minted half a second ago, and gets a constraint error
 * that describes none of that. Same reason the count below already reads `now()`.
 */
export async function revokeCredential(
  pool: Connector,
  orgId: string,
  credentialId: string,
): Promise<{ readonly revoked: boolean; readonly remainingActive: number }> {
  return asTenant(pool, orgId, async (tx) => {
    const updated = await tx.client.query(
      `UPDATE ari.agent_credentials
          SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [credentialId],
    );
    const remaining = await tx.client.query<{ count: string; agent_id: string }>(
      `SELECT count(*) AS count FROM ari.agent_credentials
        WHERE agent_id = (SELECT agent_id FROM ari.agent_credentials WHERE id = $1)
          AND revoked_at IS NULL AND expires_at > now()`,
      [credentialId],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await appendEvent(tx, {
        orgId,
        actor: 'system',
        actorType: 'system',
        eventType: 'credential.revoked',
        resource: 'credential',
        resourceId: credentialId,
        severity: 'warning',
        metadata: { credentialId },
      });
    }
    return {
      revoked: (updated.rowCount ?? 0) > 0,
      remainingActive: Number(remaining.rows[0]?.count ?? '0'),
    };
  });
}

/**
 * Rotate: mint a successor and revoke its predecessor, in one transaction.
 *
 * The ordering matters — revoking first would leave a window where an agent in the
 * middle of a deploy has no working credential, and minting without revoking would
 * leave two live secrets for one identity, which is the state that makes
 * "revoke the leaked one" an unanswerable question.
 */
export async function rotateCredential(
  tx: TenantTx,
  input: {
    readonly agentId: string;
    readonly supersedeId: string;
    readonly scopes: readonly Scope[];
    readonly ttlMs: bigint;
    readonly masterPepper: string;
    readonly actor: string;
  },
): Promise<IssuedCredential> {
  const minted = await issueCredential(tx, {
    agentId: input.agentId,
    scopes: input.scopes,
    ttlMs: input.ttlMs,
    masterPepper: input.masterPepper,
    actor: input.actor,
    rotationOf: input.supersedeId,
  });
  const superseded = await tx.client.query(
    // Dated by the database for the same reason `revokeCredential` is: the constraint
    // this row is checked against is written in the database's clock, and
    // `tx.startedAtMs` is the process's.
    `UPDATE ari.agent_credentials SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [input.supersedeId],
  );
  if ((superseded.rowCount ?? 0) === 0) {
    // Not already revoked, not missing: the transaction has to undo the mint,
    // because a second live credential is exactly what rotation was meant to end.
    throw new Error(`credential ${input.supersedeId} could not be superseded`);
  }
  return minted;
}
