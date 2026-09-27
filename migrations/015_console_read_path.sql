-- 015 — the index a per-request read needs, and nothing else.
--
-- Every read `ari-api` offered until now was by primary key, so the audit chain only ever
-- needed two access paths: `(org_id, seq)` for the log, and `(org_id, request_id)` for the
-- correlation id a decision carries. A surface that lists a tenant's payment requests has to
-- answer a different question — "why was *this row* decided that way, and what advanced it" —
-- and the answer is in `audit_events`, keyed by `resource_id`, which is the `txr_` row id.
-- Without an access path for that pair, the reason code for each row on a page of fifty is a
-- walk of the organisation's whole chain, fifty times, and it stays fast enough to look fine
-- in a test suite with one tenant and three events.
--
-- `resource` is in the key rather than left to a filter because the column is genuinely part
-- of the question: `resource_id` is free text with no FK, and a row id and an approval id are
-- not the same namespace. Seq descending matches the read, which wants the newest event for
-- a resource and nothing older.
--
-- Idempotent by rule: `tests/security/global-setup.ts` re-applies every file in this
-- directory on every run.

CREATE INDEX IF NOT EXISTS audit_events_resource_idx
  ON ari.audit_events (org_id, resource, resource_id, seq DESC);
