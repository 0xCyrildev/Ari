-- 016 — the access paths a reconciliation pass needs, and nothing else.
--
-- `@ari/reconciliation` asks six questions of one tenant, all of the shape "is anything
-- sitting in a state it should not still be in". Every one of them is a bounded read today,
-- because the tables are small and a test suite has three rows in them. That is precisely
-- the condition under which a missing index is invisible: `transaction_requests` is the
-- table this system grows fastest, and a pass that has to walk it to answer "is anything
-- parked" is a pass an operator stops running.
--
-- Three additions, and what each is *not* a duplicate of:
--
--   transaction_requests (org_id, lifecycle_state, updated_at)
--     `transaction_requests_org_idx` is `(org_id, created_at DESC)` and
--     `transaction_requests_observed_idx` is partial on the states a risk baseline reads.
--     Neither reaches "this state, since before this instant", which is the predicate every
--     parked/stalled finding is built on. `updated_at` last, because the read wants the
--     oldest offender and `min()` over an index-ordered tail is free.
--
--   signing_tickets (org_id, expires_at_ms) WHERE redeemed_at IS NULL
--     `signing_tickets_org_idx` is `(org_id, created_at DESC)` and `signing_tickets_open_idx`
--     is keyed on `(wallet_id, digest)` for the redeem path. The unredeemed-and-expired
--     count — thread 12, the number nobody could ask for — has no access path at all, and it
--     is the one query in this schema that cannot lean on row security: `011` leaves
--     `signing_tickets` outside it because the signer redeems across tenants, so the
--     `org_id` predicate here is the isolation and has to be cheap enough to be run.
--     Partial on `redeemed_at IS NULL` because spent tickets are the majority and are never
--     asked about this way.
--
--   reservations (org_id, created_at) WHERE status = 'ABANDONED'
--     `reservations_open_idx` is partial on 'HELD' and `reservations_request_idx` starts at
--     the request. Abandoned claims are re-claimable by `012`, so a pile is not a bug — it is
--     a number worth having before someone asks why a retry was slow.
--
-- `approval_requests (org_id, status, expires_at)` is deliberately absent: `006` already
-- built exactly that index, and a second copy of an access path is a write penalty with no
-- read to serve.
--
-- Idempotent by rule: `tests/security/global-setup.ts` re-applies every file in this
-- directory on every run.

CREATE INDEX IF NOT EXISTS transaction_requests_state_age_idx
  ON ari.transaction_requests (org_id, lifecycle_state, updated_at);

CREATE INDEX IF NOT EXISTS signing_tickets_expired_open_idx
  ON ari.signing_tickets (org_id, expires_at_ms)
  WHERE redeemed_at IS NULL;

CREATE INDEX IF NOT EXISTS reservations_abandoned_idx
  ON ari.reservations (org_id, created_at)
  WHERE status = 'ABANDONED';
