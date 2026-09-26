/**
 * The audit trail's two promises, tested against a database that can say no.
 *
 * "Append-only from the application's perspective" is what a compromised-app
 * attacker is left with, so the tests here split on purpose: half are the trigger
 * (which stops a bug in the writer) and half are the *grants* (which stop whoever
 * holds the application's credential). A suite that only ever connects as the
 * table owner proves the weaker of the two and reads as though it proved the
 * stronger.
 */

import { newId } from '@ari/schemas';
import {
  GENESIS,
  appendEvent,
  secretRef,
  verifyChain,
  type AuditEventTypeValue,
  type SafeLogFields,
} from '@ari/audit';
import { recordDecision, withTransaction } from '@ari/ledger';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, DATABASE_URL } from './database.js';

let pool: Awaited<ReturnType<typeof connect>>;
let privileged: Pool;

beforeAll(async () => {
  pool = await connect();
  // Its own one-client pool for the SET ROLE tests: a released client returns to
  // the pool, and a session still running as `ari_app` would quietly change the
  // privileges of whichever test borrowed it next.
  privileged = new Pool({
    connectionString: DATABASE_URL,
    max: 1,
  });
});

afterAll(async () => {
  await privileged?.end();
  await pool?.end();
});

/** Run `fn` as the unprivileged application role, and always put the session back. */
async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await privileged.connect();
  try {
    await client.query(`SET ROLE ari_app`);
    return await fn(client);
  } finally {
    await client.query(`RESET ROLE`).catch(() => undefined);
    client.release();
  }
}

async function append(orgId: string, eventType: AuditEventTypeValue) {
  return withTransaction(pool, (tx) =>
    appendEvent(tx, {
      orgId,
      actor: newId('agt'),
      actorType: 'agent',
      eventType,
      requestId: newId('req'),
      metadata: { reason: eventType },
    }),
  );
}

describe('the chain', () => {
  it('starts from genesis and links every event after it', async () => {
    const orgId = newId('org');
    const first = await append(orgId, 'agent.created');
    expect(first.prevHash).toBe(GENESIS);

    const second = await append(orgId, 'credential.issued');
    expect(second.prevHash).toBe(first.hash);

    const third = await append(orgId, 'policy.activated');
    expect(third.prevHash).toBe(second.hash);

    expect(await verifyChain(pool, orgId)).toMatchObject({ ok: true, events: 3 });
  });

  it('keeps one organisation’s chain independent of another', async () => {
    const a = newId('org');
    const b = newId('org');
    const firstA = await append(a, 'agent.created');
    const firstB = await append(b, 'agent.created');
    expect(firstA.prevHash).toBe(GENESIS);
    expect(firstB.prevHash).toBe(GENESIS);
    expect((await verifyChain(pool, a)).ok).toBe(true);
    expect((await verifyChain(pool, b)).ok).toBe(true);
  });

  it('serialises concurrent appends to one organisation without dropping a link', async () => {
    const orgId = newId('org');
    await Promise.all(
      Array.from({ length: 6 }, () => append(orgId, 'transaction.proposed')),
    );
    const report = await verifyChain(pool, orgId);
    expect(report.breaks).toEqual([]);
    expect(report.events).toBe(6);
  });

  it('detects an edit made by someone who could drop the trigger', async () => {
    // The honest worst case from §11. An attacker who escalates past the
    // application credential can remove the guard and rewrite a row; what they
    // cannot do is make the recomputed hashes agree again without rewriting every
    // successor — which is why the containment story is "prove which records are
    // trustworthy", not "this could not happen".
    const orgId = newId('org');
    await append(orgId, 'agent.created');
    const victim = await append(orgId, 'policy.activated');
    await append(orgId, 'ticket.minted');

    // A maintenance transaction, not a dropped trigger: the latter is cluster-wide
    // and would let every other suite in this run append to a history nobody is
    // guarding. This is the shape the migration offers for exactly this reason.
    const amend = await pool.connect();
    try {
      await amend.query('BEGIN');
      await amend.query(`SET LOCAL ari.audit_maintenance = 'amend'`);
      await amend.query(`UPDATE ari.audit_events SET actor = 'someone-else' WHERE id = $1`, [victim.id]);
      await amend.query('COMMIT');
    } finally {
      amend.release();
    }

    const report = await verifyChain(pool, orgId);
    expect(report.ok).toBe(false);
    expect(report.breaks.map((entry) => entry.kind)).toContain('HASH');
  });

  it('refuses a row whose link does not match the head, at the moment of writing', async () => {
    // Bypassing the writer on purpose: the trigger's job is to catch exactly the
    // case where something other than `appendEvent` tries to extend the stream
    // from a point it cannot have observed.
    const orgId = newId('org');
    await append(orgId, 'agent.created');
    await expect(
      pool.query(
        `INSERT INTO ari.audit_events
           (id, org_id, prev_hash, hash, actor, actor_type, event_type, metadata, severity)
         VALUES ($1,$2,'genesis',$3,'x','system','agent.created','{}'::jsonb,'info')`,
        [newId('aud'), orgId, `audit/v1:${'d'.repeat(64)}`],
      ),
    ).rejects.toThrow(/audit chain break/);
  });

  it('refuses a first event that does not claim genesis', async () => {
    await expect(
      pool.query(
        `INSERT INTO ari.audit_events
           (id, org_id, prev_hash, hash, actor, actor_type, event_type, metadata, severity)
         VALUES ($1,$2,$3,$4,'x','system','agent.created','{}'::jsonb,'info')`,
        [newId('aud'), newId('org'), `audit/v1:${'e'.repeat(64)}`, `audit/v1:${'f'.repeat(64)}`],
      ),
    ).rejects.toThrow(/must chain from genesis/);
  });
});

describe('redaction is structural, not disciplined', () => {
  it('refuses metadata that has no place for what it was given', async () => {
    const smuggled = { token: 'secret-looking' } as unknown as SafeLogFields;
    await expect(
      withTransaction(pool, (tx) =>
        appendEvent(tx, {
          orgId: newId('org'),
          actor: 'system',
          actorType: 'system',
          eventType: 'evaluation.error',
          metadata: smuggled,
        }),
      ),
    ).rejects.toThrow(/has no place in SafeLogFields/);
  });

  it('cannot be shown a secret-shaped field by the type either', () => {
    // @ts-expect-error — `secretShare` is not a field of SafeLogFields, so adding
    // it to an event would be a deliberate act rather than an accident.
    const fields: SafeLogFields = { secretShare: '0xabc' };
    expect(fields).toBeDefined();
  });

  it('records a hash of a sensitive value, the one thing that is always loggable', () => {
    const secret = `ari_live_${'z'.repeat(40)}`;
    const ref = secretRef(secret);
    expect(ref).toHaveLength(16);
    expect(ref).not.toContain('zzzz');
    expect(secretRef(secret)).toBe(ref);
    expect(secretRef(`${secret}!`)).not.toBe(ref);
  });
});

describe('the database refuses what the application must not do', () => {
  it('blocks UPDATE and DELETE through the trigger, even as the table owner', async () => {
    const event = await append(newId('org'), 'agent.created');
    await expect(
      pool.query(`UPDATE ari.audit_events SET actor = 'x' WHERE id = $1`, [event.id]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM ari.audit_events WHERE id = $1`, [event.id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('denies UPDATE to the application role at the grant, where no trigger is consulted', async () => {
    const event = await append(newId('org'), 'agent.created');
    await expect(
      asApp((client) => client.query(`UPDATE ari.audit_events SET actor = 'x' WHERE id = $1`, [event.id])),
    ).rejects.toThrow(/permission denied/);
  });

  it('denies TRUNCATE to the application role, the one statement a trigger cannot stop', async () => {
    await expect(asApp((client) => client.query(`TRUNCATE ari.audit_events`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('still lets the application role append, so the restriction is not an outage', async () => {
    const orgId = newId('org');
    await asApp(async (client) => {
      await client.query('BEGIN');
      await appendEvent({ client }, {
        orgId,
        actor: newId('agt'),
        actorType: 'agent',
        eventType: 'agent.created',
        metadata: {},
      });
      await client.query('COMMIT');
    });
    expect(await verifyChain(pool, orgId)).toMatchObject({ ok: true, events: 1 });
  });
});

describe('S10 — the decision is witnessed in the transaction that made it', () => {
  it('rolls both back together, so a decision with no audit row cannot exist', async () => {
    const orgId = newId('org');
    await expect(
      withTransaction(pool, async (tx) => {
        await recordDecision(tx, {
          orgId,
          requestId: newId('req'),
          policyVersionId: newId('ppv'),
          outcome: 'DENY',
          digest: null,
        });
        await appendEvent(tx, {
          orgId,
          actor: newId('agt'),
          actorType: 'agent',
          eventType: 'policy.evaluated',
          decision: 'DENY',
          reasonCodes: ['AMOUNT_EXCEEDS_PER_TRANSACTION'],
          metadata: { code: 'AMOUNT_EXCEEDS_PER_TRANSACTION' },
        });
        throw new Error('the audit writer failed');
      }),
    ).rejects.toThrow('audit writer');

    expect((await verifyChain(pool, orgId)).events).toBe(0);
    const decisions = await pool.query(`SELECT 1 FROM ari.authorization_decisions WHERE org_id = $1`, [orgId]);
    expect(decisions.rowCount).toBe(0);
  });

  it('commits both together on the success path', async () => {
    const orgId = newId('org');
    const requestId = newId('req');
    await withTransaction(pool, async (tx) => {
      await recordDecision(tx, {
        orgId,
        requestId,
        policyVersionId: newId('ppv'),
        outcome: 'ALLOW',
        digest: `canon/v1:${'c'.repeat(64)}`,
      });
      await appendEvent(tx, {
        orgId,
        requestId,
        actor: newId('agt'),
        actorType: 'agent',
        eventType: 'policy.evaluated',
        decision: 'ALLOW',
        metadata: {},
      });
    });
    expect((await verifyChain(pool, orgId)).events).toBe(1);
  });
});
