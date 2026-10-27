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

export function parsePresented(value: string, keyPrefix = 'crd_'): PresentedCredential | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [orgId, keyId, secret] = parts as [string, string, string];
  if (!orgId.startsWith('org_') || !keyId.startsWith(keyPrefix) || secret.length < 20) return null;
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

  // Dated by the database and read back from it, rather than computed from
  // `tx.startedAtMs`. The reason is the same one `revokeCredential` already states for
  // `revoked_at`, and it cuts both ways: a value written in one clock and judged in another
  // is only ever as consistent as the two agree. `verifyCredential` decides expiry on this
  // clock now, so a reader whose clock runs backwards can no longer hold a credential live
  // past the instant the row says it ended — and the string handed back to the caller is the
  // row's own, not a nearby approximation of it.
  const inserted = await tx.client.query<{ expires_at: Date }>(
    `INSERT INTO ari.agent_credentials
       (id, org_id, agent_id, key_id, secret_hash, scopes, expires_at, rotation_of)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 millisecond'), $8)
     RETURNING expires_at`,
    [keyId, tx.orgId, input.agentId, keyId, secretHash, [...input.scopes], Number(input.ttlMs), input.rotationOf ?? null],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    // `INSERT … RETURNING` yields a row or the statement fails, so this is not a state with
    // a legitimate reading. Asserting it anyway: minting a credential whose expiry nobody can
    // name would put an unbounded secret in a caller's hands.
    throw new Error(`credential ${keyId} was inserted without a returned expiry`);
  }
  const expiresAt = row.expires_at.toISOString();

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
  readonly agent_status: string;
  /**
   * Both verdicts computed in SQL, on the database clock — the clock that writes
   * `revoked_at` and the clock that now writes `expires_at`. The timestamps themselves are
   * deliberately not carried into this process: a row that hands back an instant invites a
   * comparison against whichever clock is nearest to hand, and that comparison is the defect.
   */
  readonly revoked_now: boolean;
  readonly expired_now: boolean;
}

/**
 * Verify a presented credential, with no tenant assumed and no row leaked either
 * way: an unknown `keyId` and a wrong secret produce the same refusal, so the
 * endpoint cannot be used to enumerate which agents exist (T8's enumeration half).
 *
 * It takes no clock, and that is the point. Both live/dead decisions are made where the
 * values were written; a caller cannot choose the answer by presenting a favourable time.
 */
export async function verifyCredential(
  pool: Connector,
  presented: string,
  masterPepper: string,
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
    // Computed in the reader's statement rather than as a view column, because `004` replays
    // `CREATE OR REPLACE VIEW` on every run and Postgres will not let that drop a column: a
    // view that gains a field cannot be replayed by the file that created it, which is how
    // this change first presented itself — as an unreplayable development database.
    const found = await client.query<CredentialRow>(
      `SELECT id, org_id, agent_id, secret_hash, scopes, agent_status,
              (revoked_at IS NOT NULL AND revoked_at <= now()) AS revoked_now,
              (expires_at <= now()) AS expired_now
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
  // Two refusals that used to be decided by this process's clock, and now are not. A revoked
  // credential is dead the instant the revocation commits, and an expired one is dead at the
  // instant its own row says — neither answer can be talked into "live" by a clock that runs
  // behind, which is the direction that mattered: the old expiry comparison let a lagging
  // reader honour a credential the database had already retired.
  if (row.revoked_now) return { ok: false, reason: 'CREDENTIAL_REVOKED' };
  if (row.expired_now) return { ok: false, reason: 'CREDENTIAL_EXPIRED' };

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
    // Now genuinely comparable to `verifyCredential`, because `expires_at` is written by this
    // same clock: "still active" here and "still authenticates" there are the one predicate,
    // read off the one clock. Before, an operator could be told `0 remaining` about a
    // credential the service was still honouring.
    const remaining = await tx.client.query<{ count: string }>(
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

/**
 * The human half: an approver's credential.
 *
 * Same three separations as the agent half — identity from secret, pepper from the
 * database, a tenant named in the presentation that authorises nothing — and one
 * addition that only exists because there are now two kinds of subject: the key id
 * carries the kind. `ucrd_` will not parse as an agent credential and `crd_` will not
 * parse as a user one, so a human secret presented at the agent gate and an agent secret
 * presented at the approver gate both fail the same way a wrong secret does, without
 * either endpoint having to know which kind it was hoping for.
 *
 * What it is *for* is the boundary the product is made of: the subject that proposes a
 * payment and the subject that approves it are different, and `013` puts that in a CHECK
 * rather than in this file's good intentions. The refusal below is the same rule stated
 * where it can produce a sentence a caller can read.
 */
export type UserCredentialFailure =
  | 'USER_NOT_FOUND'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_REVOKED'
  | 'USER_SUSPENDED'
  | 'ORGANIZATION_MISMATCH';

export type UserCredentialResult =
  | {
      readonly ok: true;
      readonly orgId: string;
      readonly userId: string;
      readonly credentialId: string;
      readonly scopes: readonly Scope[];
    }
  | { readonly ok: false; readonly reason: UserCredentialFailure };

interface UserCredentialRow {
  readonly id: string;
  readonly org_id: string;
  readonly user_id: string;
  readonly secret_hash: string;
  readonly scopes: string[];
  readonly user_status: string;
  /** The same two SQL-decided verdicts as the agent half, on the same clock. */
  readonly revoked_now: boolean;
  readonly expired_now: boolean;
}

export async function issueUserCredential(
  tx: TenantTx,
  input: {
    readonly userId: string;
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
  if (input.scopes.includes('transaction:request')) {
    throw new RangeError('a human credential cannot carry transaction:request — the subject that proposes is not the subject that approves');
  }
  if (input.ttlMs <= 0n) {
    throw new RangeError('credentials expire; pass a positive ttl');
  }
  const keyId = newId('ucrd');
  const secret = randomBytes(32).toString('base64url');
  const secretHash = await hash(salted(input.masterPepper, tx.orgId, secret));
  const inserted = await tx.client.query<{ expires_at: Date }>(
    `INSERT INTO ari.user_credentials
       (id, org_id, user_id, key_id, secret_hash, scopes, expires_at, rotation_of)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 millisecond'), $8)
     RETURNING expires_at`,
    [keyId, tx.orgId, input.userId, keyId, secretHash, [...input.scopes], Number(input.ttlMs), input.rotationOf ?? null],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow === undefined) {
    throw new Error(`user credential ${keyId} was inserted without a returned expiry`);
  }
  const expiresAt = insertedRow.expires_at.toISOString();

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

  return { credentialId: keyId, presented: `${tx.orgId}.${keyId}.${secret}`, scopes: input.scopes, expiresAt };
}

/**
 * Verify a presented user credential.
 *
 * Identical in shape to `verifyCredential`, including the part that looks
 * redundant: the pepper for a *claimed* organisation is hashed even when no row
 * matched, so a miss does not answer faster than a hit, and every failure at this
 * boundary is one code and one shape for the same reason (T8).
 */
export async function verifyUserCredential(
  pool: Connector,
  presented: string,
  masterPepper: string,
): Promise<UserCredentialResult> {
  const parsed = parsePresented(presented, 'ucrd_');
  if (parsed === null) return { ok: false, reason: 'USER_NOT_FOUND' };

  const client = await pool.connect();
  let row: UserCredentialRow | undefined;
  try {
    const found = await client.query<UserCredentialRow>(
      `SELECT id, org_id, user_id, secret_hash, scopes, user_status,
              (revoked_at IS NOT NULL AND revoked_at <= now()) AS revoked_now,
              (expires_at <= now()) AS expired_now
         FROM ari.user_credential_lookup
        WHERE key_id = $1`,
      [parsed.keyId],
    );
    row = found.rows[0];
  } finally {
    client.release();
  }

  if (row === undefined || row.org_id !== parsed.orgId) {
    await hash(salted(masterPepper, parsed.orgId, parsed.secret));
    return { ok: false, reason: 'USER_NOT_FOUND' };
  }

  const secretMatches = await verify(row.secret_hash, salted(masterPepper, row.org_id, parsed.secret)).catch(() => false);
  if (!secretMatches) return { ok: false, reason: 'USER_NOT_FOUND' };

  // `users.status` had no reader at all before this line: `004` gave it a CHECK on its
  // values and nothing ever consulted them, so suspending a person was a database write
  // with no security consequence and an operator who believed they had stopped someone.
  if (row.user_status === 'SUSPENDED') return { ok: false, reason: 'USER_SUSPENDED' };
  // The same single-clock rule as `verifyCredential`: an approver's retired secret is dead on
  // the clock that retired it, and no reading of this process's time can make it live again.
  if (row.revoked_now) return { ok: false, reason: 'CREDENTIAL_REVOKED' };
  if (row.expired_now) return { ok: false, reason: 'CREDENTIAL_EXPIRED' };

  return {
    ok: true,
    orgId: row.org_id,
    userId: row.user_id,
    credentialId: row.id,
    scopes: row.scopes as Scope[],
  };
}

export async function revokeUserCredential(
  pool: Connector,
  orgId: string,
  credentialId: string,
): Promise<{ readonly revoked: boolean; readonly remainingActive: number }> {
  return asTenant(pool, orgId, async (tx) => {
    const updated = await tx.client.query(
      `UPDATE ari.user_credentials SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, user_id`,
      [credentialId],
    );
    const target = updated.rows[0] as { id: string; user_id: string } | undefined;
    if (target !== undefined) {
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
    const remaining = await tx.client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ari.user_credentials
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [target?.user_id ?? credentialId],
    );
    return {
      revoked: target !== undefined,
      remainingActive: Number(remaining.rows[0]?.count ?? '0'),
    };
  });
}
