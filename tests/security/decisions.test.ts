/**
 * The ordering, enforced below the application.
 *
 * Phase 3's gate asks for a trigger that refuses a signing ticket without an
 * `ALLOW` decision behind it. That rule is worth having precisely because the
 * TypeScript around it is already good: the case this covers is the code that
 * bypasses the TypeScript, whether by bug or by a compromised decision plane
 * talking to the database directly (T18).
 */

import { newId } from '@ari/schemas';
import { claimTicket, mintTicket, recordDecision, withTransaction } from '@ari/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './database.js';

let pool: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  pool = await connect();
});

afterAll(async () => {
  await pool?.end();
});

const DIGEST = `canon/v1:${'a'.repeat(64)}`;
const OTHER_DIGEST = `canon/v1:${'b'.repeat(64)}`;
const walletId = newId('wal');

function decision(outcome: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL') {
  return {
    orgId: newId('org'),
    requestId: newId('req'),
    policyVersionId: newId('ppv'),
    outcome,
    digest: outcome === 'DENY' ? null : DIGEST,
  };
}

describe('a ticket needs an ALLOW underneath it', () => {
  it('mints against an ALLOW decision', async () => {
    const row = await withTransaction(pool, async (tx) => {
      const allowed = await recordDecision(tx, decision('ALLOW'));
      return mintTicket(tx, {
        decisionId: allowed.id,
        digest: DIGEST,
        walletId,
        expiresAtMs: 1_761_400_060_000n,
      });
    });
    expect(row.id).toMatch(/^tkt_/);
  });

  it('refuses to mint against a DENY, whatever the application believes', async () => {
    await expect(
      withTransaction(pool, async (tx) => {
        const denied = await recordDecision(tx, decision('DENY'));
        return mintTicket(tx, { decisionId: denied.id, digest: DIGEST, walletId, expiresAtMs: 1_761_400_060_000n });
      }),
    ).rejects.toThrow(/not backed by an ALLOW decision/);
  });

  it('refuses to mint against a decision that is merely pending a human', async () => {
    await expect(
      withTransaction(pool, async (tx) => {
        const review = await recordDecision(tx, decision('REQUIRE_HUMAN_APPROVAL'));
        return mintTicket(tx, { decisionId: review.id, digest: DIGEST, walletId, expiresAtMs: 1_761_400_060_000n });
      }),
    ).rejects.toThrow(/not backed by an ALLOW decision/);
  });

  it('refuses a ticket sealing a digest its decision was not about', async () => {
    // The T10/T11 shape in one row: the decision exists and says yes, and the
    // ticket points at slightly different bytes.
    await expect(
      withTransaction(pool, async (tx) => {
        const allowed = await recordDecision(tx, decision('ALLOW'));
        return mintTicket(tx, {
          decisionId: allowed.id,
          digest: OTHER_DIGEST,
          walletId,
          expiresAtMs: 1_761_400_060_000n,
        });
      }),
    ).rejects.toThrow(/digest its decision was not about/);
  });

  it('refuses a ticket with no decision behind it at all', async () => {
    // Two rules could report this, and which one does is worth being explicit about:
    // `mintTicket` derives the ticket's tenant from the decision row it points at, so a
    // decision that does not exist produces no insert at all and the writer's own error,
    // while a decision that exists but refused the payment reaches the trigger. The
    // message differs; neither is a constraint name the operator has to decode.
    await expect(
      withTransaction(pool, (tx) =>
        mintTicket(tx, { decisionId: newId('dec'), digest: DIGEST, walletId, expiresAtMs: 1_761_400_060_000n }),
      ),
    ).rejects.toThrow(/no such decision/);
  });
});

/** Inside every ticket minted below (`expiresAtMs` ends ...060_000). */
const INSIDE_WINDOW = 1_761_400_030_000n;
/** One millisecond past the last of them. */
const AFTER_WINDOW = 1_761_400_060_001n;

describe('single use is a row, not a flag', () => {
  it('claims once and never again', async () => {
    const ticketId = await withTransaction(pool, async (tx) => {
      const allowed = await recordDecision(tx, decision('ALLOW'));
      const row = await mintTicket(tx, {
        decisionId: allowed.id,
        digest: DIGEST,
        walletId,
        expiresAtMs: 1_761_400_060_000n,
      });
      return row.id;
    });

    const first = await withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, INSIDE_WINDOW));
    expect(first).toBe(true);
    const second = await withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, INSIDE_WINDOW));
    expect(second).toBe(false);
  });

  it('refuses a claim that presents different bytes than the row sealed', async () => {
    const ticketId = await withTransaction(pool, async (tx) => {
      const allowed = await recordDecision(tx, decision('ALLOW'));
      return (await mintTicket(tx, {
        decisionId: allowed.id,
        digest: DIGEST,
        walletId,
        expiresAtMs: 1_761_400_060_000n,
      })).id;
    });
    expect(await withTransaction(pool, (tx) => claimTicket(tx, ticketId, OTHER_DIGEST, INSIDE_WINDOW))).toBe(false);
    // And the ticket is still there for its rightful bytes: a wrong presentation
    // must not be able to burn a legitimate authorisation.
    expect(await withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, INSIDE_WINDOW))).toBe(true);
  });

  it('admits exactly one of two concurrent claims on the same ticket', async () => {
    const ticketId = await withTransaction(pool, async (tx) => {
      const allowed = await recordDecision(tx, decision('ALLOW'));
      return (await mintTicket(tx, {
        decisionId: allowed.id,
        digest: DIGEST,
        walletId,
        expiresAtMs: 1_761_400_060_000n,
      })).id;
    });

    const claims = await Promise.all([
      withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, INSIDE_WINDOW)),
      withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, INSIDE_WINDOW)),
      withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, INSIDE_WINDOW)),
    ]);
    expect(claims.filter((claimed) => claimed)).toHaveLength(1);
  });

  it('refuses a claim presented after the window the row recorded', async () => {
    // The seal the caller hands over states its own expiry, and a seal is a claim. This
    // row's `expires_at_ms` was written at the moment of authorisation, which is the
    // only reason "60 seconds" bounds anything: single use without a window is an
    // authorisation that never lapses, and a ticket kept in a drawer is still a ticket.
    const ticketId = await withTransaction(pool, async (tx) => {
      const allowed = await recordDecision(tx, decision('ALLOW'));
      return (await mintTicket(tx, {
        decisionId: allowed.id,
        digest: DIGEST,
        walletId,
        expiresAtMs: 1_761_400_060_000n,
      })).id;
    });
    expect(await withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, AFTER_WINDOW))).toBe(false);
    // Refusing an expired presentation must not spend it either: the row was never
    // claimable, and `redeemed_at` staying NULL is what tells a reconciliation pass
    // "this authorisation lapsed" rather than "this authorisation signed something".
    const redeemed = await pool.query<{ redeemed_at: Date | null }>(
      `SELECT redeemed_at FROM ari.signing_tickets WHERE id = $1`,
      [ticketId],
    );
    expect(redeemed.rows[0]?.redeemed_at).toBeNull();
    // And the same ticket, one millisecond earlier, was claimable — so what refused it
    // is the clock and not something about the row.
    expect(await withTransaction(pool, (tx) => claimTicket(tx, ticketId, DIGEST, INSIDE_WINDOW))).toBe(true);
  });
});

describe('what a decision row will not let you write', () => {
  it('refuses an ALLOW with no digest, because it would commit to nothing', async () => {
    await expect(
      withTransaction(pool, (tx) => recordDecision(tx, { ...decision('ALLOW'), digest: null })),
    ).rejects.toThrow(/digest_present_when_it_commits|check constraint/);
  });

  it('refuses an outcome outside the three the engine can produce', async () => {
    await expect(
      withTransaction(pool, (tx) => recordDecision(tx, { ...decision('ALLOW'), outcome: 'PROCEED' as 'ALLOW' })),
    ).rejects.toThrow(/authorization_decisions_outcome_check|check constraint/);
  });
});
