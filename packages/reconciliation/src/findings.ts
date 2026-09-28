/**
 * The six things that can be true of a tenant's rows and mean nobody finished a payment,
 * with the one query each is read by.
 *
 * Every statement here is a SELECT, and every one names its tenant in the `WHERE`. That
 * second part is not redundancy for comfort: `signing_tickets` is the one table in this
 * schema with no row security (`011`'s documented exception, because the signer redeems
 * across tenants), so for that query the predicate *is* the isolation, and a future reader
 * must not be able to mistake it for a filter the database would have applied anyway.
 *
 * The clock is a parameter everywhere. `now()` would be one second more convenient and
 * would put the threshold for "parked" at the mercy of whichever database answered — the
 * same reason `TenantTx.startedAtMs` is supplied rather than read.
 */

export const FINDING_CODES = [
  'APPROVAL_EXPIRED_UNANSWERED',
  'DELIVERY_PARKED',
  'TICKET_REDEEMED_NOT_RECORDED',
  'TICKET_MINTED_NOT_REDEEMED',
  'ABANDONED_CLAIMS_ACCUMULATED',
  'STATE_MACHINE_STALLED',
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

export interface FindingQuery {
  readonly code: FindingCode;
  /**
   * `count`, `oldest_id`, `oldest_at`. One row, always: an aggregate with no GROUP BY.
   *
   * `$1` is the organisation, `$2` the cutoff instant (now minus the threshold), `$3` the
   * same `now` as epoch milliseconds, because `signing_tickets.expires_at_ms` is a `bigint`
   * of milliseconds and comparing it to a timestamp silently is how a window in
   * milliseconds meets a column in seconds — the trap `AGENTS.md` records for
   * `to_timestamp`.
   */
  readonly sql: string;
  /**
   * The bind list for exactly this statement.
   *
   * Declared beside the SQL rather than built once for all six, because the two ends of
   * that pairing are both errors: a bind list longer than the statement references is
   * "bind message supplies 3 parameters, but prepared statement requires 2", and a
   * parameter that is bound but never mentioned is "could not determine data type of
   * parameter $2" — Postgres infers a type from where a placeholder is used, so an unused
   * one has none. Both were measured here, in that order, against a shared bind array.
   */
  readonly params: (clock: { readonly orgId: string; readonly cutoff: Date; readonly nowMs: number }) => unknown[];
}

export const FINDING_QUERIES: readonly FindingQuery[] = [
  {
    // A human was asked, never answered, and the deadline passed. `recordDecision` refuses
    // an expired row by reading `expires_at <= now()` from the row itself, so nothing ever
    // flips this status: the request sits at `APPROVAL_PENDING` and the approval sits at
    // `PENDING` until somebody retries with a new candidate.
    //
    // It does *not* hold capacity, and that is the reason this query has no join to
    // `reservations`. `reserve` runs downstream of the approval branch, so a request waiting
    // for a person has nothing parked against the daily window — a predicate requiring a
    // `HELD` row here would have been a finding that can never fire, which is the defect
    // `AGENTS.md` records for a policy option that silently evaluates to false.
    code: 'APPROVAL_EXPIRED_UNANSWERED',
    sql: `
      SELECT count(*)::int AS count,
             (array_agg(a.request_id ORDER BY a.expires_at ASC))[1] AS oldest_id,
             min(a.expires_at) AS oldest_at
        FROM ari.approval_requests a
       WHERE a.org_id = $1
         AND a.status = 'PENDING'
         AND a.expires_at < $2`,
    params: ({ orgId, cutoff }) => [orgId, cutoff],
  },
  {
    // Minted, older than the threshold, and never redeemed: the ticket exists, nobody
    // signed, and the hold is parked. This is the state a `TICKET_ISSUED_NOT_DELIVERED`
    // leaves behind, and it is parked *on purpose* — a retry re-delivers the same ticket.
    // The finding is not that it happened, it is that it is still true an hour later.
    code: 'DELIVERY_PARKED',
    sql: `
      SELECT count(*)::int AS count,
             (array_agg(t.id ORDER BY t.updated_at ASC))[1] AS oldest_id,
             min(t.updated_at) AS oldest_at
        FROM ari.transaction_requests t
       WHERE t.org_id = $1
         AND t.lifecycle_state = 'TICKET_MINTED'
         AND t.updated_at < $2
         AND NOT EXISTS (
               SELECT 1
                 FROM ari.authorization_decisions d
                 JOIN ari.signing_tickets s ON s.decision_id = d.id
                WHERE d.org_id = t.org_id AND d.request_id = t.id AND s.redeemed_at IS NOT NULL
             )`,
    params: ({ orgId, cutoff }) => [orgId, cutoff],
  },
  {
    // The one that is an incident rather than a backlog item: the authority plane spent the
    // ticket — single use, one-way door, `012` — and the decision plane never recorded the
    // answer. A signature exists that Ari's own books do not acknowledge, and the capacity
    // is still held. Nothing here can fix it, which is exactly why it must be named.
    code: 'TICKET_REDEEMED_NOT_RECORDED',
    sql: `
      SELECT count(*)::int AS count,
             (array_agg(t.id ORDER BY t.updated_at ASC))[1] AS oldest_id,
             min(t.updated_at) AS oldest_at
        FROM ari.transaction_requests t
       WHERE t.org_id = $1
         AND t.lifecycle_state IN ('TICKET_MINTED', 'SIGNING_PENDING')
         AND EXISTS (
               SELECT 1
                 FROM ari.authorization_decisions d
                 JOIN ari.signing_tickets s ON s.decision_id = d.id
                WHERE d.org_id = t.org_id AND d.request_id = t.id AND s.redeemed_at IS NOT NULL
             )`,
    params: ({ orgId }) => [orgId],
  },
  {
    // Thread 12, counted per tenant at last. An expired, unredeemed ticket is unspendable —
    // the signer's own clock refuses it, which is the point — and it stays forever, because
    // `008` withholds DELETE from `ari_app` on purpose and a one-way door in the schema is
    // worth more than a tidy table. This finding is the reconciliation pass that *names*
    // them instead of the delete that would hide them.
    code: 'TICKET_MINTED_NOT_REDEEMED',
    sql: `
      SELECT count(*)::int AS count,
             (array_agg(s.id ORDER BY s.expires_at_ms ASC))[1] AS oldest_id,
             -- expires_at_ms is milliseconds; to_timestamp takes seconds. Divided
             -- explicitly, in the same expression that reads it, so the units cannot drift
             -- apart when someone moves the aggregate.
             to_timestamp((array_agg(s.expires_at_ms ORDER BY s.expires_at_ms ASC))[1] / 1000.0) AS oldest_at
        FROM ari.signing_tickets s
       WHERE s.org_id = $1
         AND s.redeemed_at IS NULL
         AND s.expires_at_ms < $2`,
    // The one query bound with the millisecond clock, because `expires_at_ms` is the only
    // column in this set stored in milliseconds — and it is `$2`, not `$3`, because a
    // placeholder number is a position in the bind list and there is no cutoff in this
    // statement to hold the second seat open.
    params: ({ orgId, nowMs }) => [orgId, nowMs],
  },
  {
    // An idempotency claim whose transaction never came back. `012` made these re-claimable
    // (`ABANDONED → PENDING`) precisely so a retry is not a 500, so a live count is not a
    // bug — it is the size of the pile a re-claim has to walk past, and the number an
    // operator wants before it is a question about a specific payment.
    code: 'ABANDONED_CLAIMS_ACCUMULATED',
    sql: `
      SELECT count(*)::int AS count,
             (array_agg(r.id ORDER BY r.created_at ASC))[1] AS oldest_id,
             min(r.created_at) AS oldest_at
        FROM ari.reservations r
       WHERE r.org_id = $1
         AND r.status = 'ABANDONED'`,
    params: ({ orgId }) => [orgId],
  },
  {
    // Anything left inside the pre-decision states past the threshold. A request in
    // `EVALUATING` for an hour is not slow, it is a transaction that began and never
    // committed — which the advisory lock makes impossible in one process and unremarkable
    // across a deploy that killed one.
    code: 'STATE_MACHINE_STALLED',
    sql: `
      SELECT count(*)::int AS count,
             (array_agg(t.id ORDER BY t.updated_at ASC))[1] AS oldest_id,
             min(t.updated_at) AS oldest_at
        FROM ari.transaction_requests t
       WHERE t.org_id = $1
         AND t.lifecycle_state IN ('DRAFT', 'VALIDATED', 'EVALUATING', 'RESERVED', 'APPROVAL_GRANTED')
         AND t.updated_at < $2`,
    params: ({ orgId, cutoff }) => [orgId, cutoff],
  },
];

/**
 * How long a row may sit in any of these states before it is a finding rather than a
 * step in progress.
 *
 * Five minutes, which is two orders of magnitude above the measured p50 of a payment
 * (~30 ms) and well inside the shortest ticket TTL this system issues. A threshold that
 * could not be distinguished from normal operation would produce a report that reads as
 * noise, and the first operator to see noise stops reading the report.
 */
export const DEFAULT_PARKED_THRESHOLD_SECONDS = 300;
