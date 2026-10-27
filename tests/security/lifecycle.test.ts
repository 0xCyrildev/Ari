/**
 * Two copies of one state machine, and the test that keeps them honest about it.
 *
 * `011` moved the request lifecycle into the schema — a CHECK on the values and a
 * trigger on the edges — because the rule was already being enforced, in TypeScript,
 * at the one call site that remembered to call `setRequestState`. Any other writer (a
 * migration, a support script, a compromised plane talking SQL) could put a settled
 * payment back into `APPROVAL_PENDING`, and the two partial indexes that decide what
 * "settled" and "authorised" *mean* are defined over those strings.
 *
 * That leaves the repo holding the same machine twice, which is a bug of its own
 * waiting to happen: the day somebody widens `TRANSITIONS` in
 * `packages/transaction-engine` and does not touch the trigger, the database refuses a
 * transition the application believes is legal — in production, on the way to a
 * payment. So this file tests neither copy in isolation. It runs every pair against
 * Postgres and compares what the database allowed with what the TypeScript says it
 * allows, in both directions.
 */

import { asTenant, createAgent, createOrganization, createWallet } from '@ari/identity';
import { newId } from '@ari/schemas';
import { LifecycleState, canTransition, isTerminal } from '@ari/transaction-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './database.js';

/**
 * The states, read from the enumeration itself.
 *
 * Restating the list inside a test would make it a third copy of the machine, and the
 * third copy is always the one that drifts.
 */
const STATES = LifecycleState.options;
type State = LifecycleState;

let app: Awaited<ReturnType<typeof connect>>;
let orgId: string;
let agentId: string;
let walletId: string;

beforeAll(async () => {
  // `ari_app`, and through the identity writers rather than raw SQL: this tenant has
  // to exist the way a real one does, or the file is testing a row shape the
  // application cannot produce.
  app = await connect(2, 'ari_app');
  orgId = await createOrganization(app, { name: 'lifecycle gate', bootstrapActor: 'system' });
  const made = await asTenant(app, orgId, async (tx) => {
    const agent = await createAgent(tx, { name: 'gate', createdBy: 'system' });
    const wallet = await createWallet(tx, {
      displayName: 'gate',
      mode: 'delegated',
      signatureTriple: `0x${'11'.repeat(32)}`,
      provider: 'mock',
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      actor: 'system',
    });
    return { agent, wallet };
  });
  agentId = made.agent;
  walletId = made.wallet;
});

afterAll(async () => {
  await app?.end();
});

interface Attempt {
  readonly from: State;
  readonly to: State;
  readonly allowed: boolean;
  readonly refusal: string;
}

/**
 * One row, started in `from`, then asked for every state in turn.
 *
 * All seventeen attempts share one tenant transaction and each is wrapped in a
 * savepoint. Without the savepoint the first refusal aborts the transaction, and
 * *every later statement then reads as a refusal too* — a test shaped exactly like
 * one that passes when the trigger is broken. With it, the database's own verdict on
 * each edge is observed, and the transaction survives to ask the next.
 *
 * The row is inserted already in `from`, because the only way to ask whether
 * `APPROVAL_GRANTED → RESERVED` is legal is to have a row in `APPROVAL_GRANTED`;
 * walking there through the real edges would be testing the path, not the rule. The
 * rows are committed and left behind, which is why the tenant above is one this file
 * created and nobody else reads.
 */
async function attemptsFrom(from: State): Promise<readonly Attempt[]> {
  return asTenant(app, orgId, async (tx) => {
    const inserted = await tx.client.query<{ id: string }>(
      `INSERT INTO ari.transaction_requests
         (id, org_id, agent_id, wallet_id, idempotency_key, canonical, digest, lifecycle_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [newId('txr'), orgId, agentId, walletId, `gate:${from}`, 'o{gate}', `canon/v1:${'a'.repeat(64)}`, from],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error(`the fixture row for ${from} did not land`);

    const attempts: Attempt[] = [];
    for (const to of STATES) {
      await tx.client.query('SAVEPOINT edge');
      let allowed = true;
      let refusal = '';
      try {
        await tx.client.query(`UPDATE ari.transaction_requests SET lifecycle_state = $2 WHERE id = $1`, [id, to]);
      } catch (error) {
        allowed = false;
        refusal = (error as Error).message;
      }
      // Unconditionally, not only after a refusal. A savepoint released on success
      // *keeps* the row in the state the last attempt moved it to, so every later
      // attempt in this loop would be measured from a different `OLD` than the one it
      // is reported against — which is precisely the wrong way round for a test whose
      // whole subject is which `OLD` allows which `NEW`. Rolling back costs nothing and
      // leaves the row exactly where the fixture put it.
      await tx.client.query('ROLLBACK TO SAVEPOINT edge');
      attempts.push({ from, to, allowed, refusal });
    }
    return attempts;
  });
}

let matrix: readonly Attempt[] = [];

beforeAll(async () => {
  const all: Attempt[] = [];
  for (const from of STATES) all.push(...(await attemptsFrom(from)));
  matrix = all;
  // The guard against a matrix that measured nothing: seventeen rows, each asked for
  // seventeen states. If a fixture silently stopped producing rows this test would
  // agree with the database out of emptiness.
  expect(matrix.length).toBe(STATES.length * STATES.length);
});

describe('the database and the TypeScript agree on the lifecycle', () => {
  it('accepts every edge the application believes is legal, and only those', () => {
    const disagreements = matrix
      .filter((edge) => edge.from !== edge.to)
      .filter((edge) => edge.allowed !== canTransition(edge.from, edge.to))
      .map((edge) => `${edge.from} -> ${edge.to}: database ${edge.allowed ? 'ALLOWED' : 'REFUSED'}, TypeScript ${canTransition(edge.from, edge.to) ? 'allows' : 'refuses'}${edge.refusal.length > 0 ? ` (${edge.refusal.split('\n')[0]})` : ''}`);
    expect(disagreements).toEqual([]);
  });

  it('refuses a rewrite of a terminal state, and tolerates one of a live one', () => {
    // The self-write case is not covered by `canTransition`, which has no self edges at
    // all, and it is the case a retry loop produces by accident: `RESERVED → RESERVED`
    // from two workers that both think they advanced the same request. The schema's
    // answer is deliberate — a live state may be re-written to itself, a terminal one
    // may not, because `DENIED → DENIED` is what a duplicate decision looks like from
    // outside and it should raise rather than quietly succeed.
    const selfWrites = matrix.filter((edge) => edge.from === edge.to);
    expect(selfWrites.length).toBe(STATES.length);
    const wrong = selfWrites
      .filter((edge) => edge.allowed === isTerminal(edge.from))
      .map((edge) => `${edge.from} -> ${edge.from}: terminal=${isTerminal(edge.from)} but the database ${edge.allowed ? 'accepted' : 'refused'} it`);
    expect(wrong).toEqual([]);
  });

  it('knows exactly the states the enumeration knows', async () => {
    // The CHECK is a second list of the same values, and a state added to the schema
    // without it is a state no row can ever hold — which fails as a check violation in
    // whichever path first reaches it, at the worst moment available.
    const definition = await app.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'transaction_requests_lifecycle_known_state'
          AND conrelid = 'ari.transaction_requests'::regclass`,
    );
    const sql = [...(definition.rows[0]?.def ?? '').matchAll(/'([A-Z][A-Z_]*)'::text/g)].map((m) => m[1]).sort();
    expect(sql).toEqual([...STATES].sort());
  });

  it('names the transition it refused, so a support ticket can be read', () => {
    // The refusal has to be diagnosable from the message alone: this exception is what
    // an operator sees, and "check violation" on a column that already holds a
    // permitted value tells them nothing about which of the two copies is wrong.
    const refused = matrix.find((edge) => edge.from === 'DENIED' && edge.to === 'APPROVAL_GRANTED');
    expect(refused?.allowed).toBe(false);
    expect(refused?.refusal).toContain('DENIED');
    expect(refused?.refusal).toContain('APPROVAL_GRANTED');
  });
});
