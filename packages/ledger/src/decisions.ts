/**
 * Decisions and tickets in Postgres — the part of the ordering that does not
 * live in TypeScript.
 *
 * `ARCHITECTURE` §1 promises that no path runs from a model output to a
 * signature. The kernel enforces that with types, and types are erased the moment
 * someone writes a `SELECT`. These three functions are what the database will
 * still refuse after that: a ticket row cannot be inserted unless an `ALLOW`
 * decision row backs it, and the row cannot seal a digest the decision was not
 * about (see `sql/002_decisions_and_tickets.sql`).
 */

import { newId } from '@ari/schemas';
import type { LedgerTx } from './index.js';

export type DecisionOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';

export interface DecisionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly requestId: string;
  readonly policyVersionId: string;
  readonly outcome: DecisionOutcome;
  /** Omitted for a DENY: the canonicaliser may have refused the candidate outright. */
  readonly digest: string | null;
}

export async function recordDecision(
  tx: LedgerTx,
  input: Omit<DecisionRecord, 'id'>,
): Promise<DecisionRecord> {
  const id = newId('dec');
  await tx.client.query(
    `INSERT INTO ari.authorization_decisions (id, org_id, request_id, policy_version_id, outcome, digest)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.orgId, input.requestId, input.policyVersionId, input.outcome, input.digest],
  );
  return { ...input, id };
}

export interface TicketRow {
  readonly id: string;
  readonly decisionId: string;
  readonly digest: string;
  readonly walletId: string;
  readonly expiresAtMs: bigint;
}

/**
 * Write the row a presented ticket will be checked against.
 *
 * The insert is where the database's own rule fires: pointing this at a DENY or
 * a REQUIRE_HUMAN_APPROVAL decision raises rather than recording, so the calling
 * code cannot get the ordering wrong quietly.
 */
export async function mintTicket(tx: LedgerTx, input: Omit<TicketRow, 'id'>): Promise<TicketRow> {
  const id = newId('tkt');
  // The tenant is *derived*, not passed. `011` made `signing_tickets.org_id` real so a
  // ticket can be counted and reconciled per tenant, and the only honest source for it is
  // the decision the row already points at — a caller that supplied `orgId` itself could
  // attach a ticket to a tenant whose policy never authorised it, which is the one thing
  // the column would otherwise be there to prevent. `002`'s trigger still refuses a row
  // with no ALLOW behind it; this statement refuses one with no decision at all.
  const minted = await tx.client.query(
    `INSERT INTO ari.signing_tickets (id, org_id, decision_id, digest, wallet_id, expires_at_ms)
     SELECT $1, d.org_id, d.id, $3, $4, $5
       FROM ari.authorization_decisions d
      WHERE d.id = $2`,
    [id, input.decisionId, input.digest, input.walletId, input.expiresAtMs.toString()],
  );
  if ((minted.rowCount ?? 0) === 0) {
    throw new Error(`ticket cannot be minted against decision ${input.decisionId}: no such decision`);
  }
  return { ...input, id };
}

/**
 * Claim a ticket for one presentation.
 *
 * Atomic because two concurrent presentations of the same string must not both
 * be told they won: the update filters on `redeemed_at IS NULL` and on the
 * digest the row was created with, so a second caller — or the same caller with
 * different bytes — gets `false` and refuses.
 *
 * `nowMs` is the *presenter's* clock, and the row's own `expires_at_ms` is what it is
 * compared against. That direction is the whole point: the seal a caller hands over
 * states its own expiry, and a seal is a claim, while this row was written by the
 * decision plane at the moment it authorised the payment. Single use without a window
 * would mean an authorisation that never lapses — a ticket kept in a drawer is still a
 * ticket, and "60 seconds" has to be enforced somewhere that is not the document being
 * verified.
 */
export async function claimTicket(
  tx: LedgerTx,
  ticketId: string,
  digest: string,
  nowMs: bigint,
): Promise<boolean> {
  const claimed = await tx.client.query<{ id: string }>(
    `UPDATE ari.signing_tickets
        SET redeemed_at = now()
      WHERE id = $1 AND digest = $2 AND redeemed_at IS NULL AND expires_at_ms > $3
      RETURNING id`,
    [ticketId, digest, nowMs.toString()],
  );
  return (claimed.rowCount ?? 0) > 0;
}
