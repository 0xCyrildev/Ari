-- Reservation lifecycle, the monthly window, and the paths the hot query takes.
--
-- Three things this migration fixes, in the order they were found:
--
-- 1. **A denial that could not be written.** `reserve()` claimed an idempotency row,
--    and when the cap refused it tried to `DELETE` that claim. `008` grants
--    `ari_app` SELECT/INSERT/UPDATE on `reservations` and deliberately no DELETE —
--    "a role that could remove a row could remove the evidence". So the over-limit
--    race, run as the role the service actually runs as, threw `permission denied`
--    instead of returning `LIMIT_EXCEEDED`: a 500, a rolled-back transaction, and no
--    `LIMIT_RESERVATION_FAILED` audit event for the refusal that did happen. The claim
--    row now moves to a status instead of disappearing, which is what the table was
--    designed to do.
--
-- 2. **A monthly cap with no rows behind it.** `001` keyed the idempotency claim on
--    `(agent_id, idempotency_key)`, which allows exactly one reservation per request —
--    so a request could only ever be held against one window, and the pipeline has been
--    supplying `reservedMonthRaw: 0` ever since. A policy could write `perMonth`, the
--    kernel would check it, and the answer it checked against was a constant. The claim
--    is now keyed per dimension, which is what a multi-window limit needs.
--
-- 3. **Indexes for queries that were scanning.** Named below, each one is a query in
--    the live path that had no usable index; `EXPLAIN` output is the evidence, and this
--    file's claims are testable by running it.

-- ---------------------------------------------------------------------------
-- 1. Reservation statuses: a claim is born pending, becomes a hold, or is abandoned.
-- ---------------------------------------------------------------------------

-- Dropped by name before being re-added, for the same reason as the unique key below.
ALTER TABLE ari.reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE ari.reservations
  ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('PENDING', 'HELD', 'SETTLED', 'RELEASED', 'ABANDONED'));

-- The status advances and does not wander: a row that was abandoned or released can
-- never become money again, and only this transaction's own claim is ever `PENDING`.
CREATE OR REPLACE FUNCTION ari.reservation_status_progresses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'PENDING' AND NEW.status IN ('HELD', 'ABANDONED') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'HELD' AND NEW.status IN ('SETTLED', 'RELEASED') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'ABANDONED' AND NEW.status = 'PENDING' THEN
    -- Re-claimed by a later attempt with the same key, after the first one was refused
    -- on capacity. This is the only backwards step, and it is a new hold being taken,
    -- not an old one being revived: `resolved_at` and the counter move with it.
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'reservation % is %; it does not become %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS reservation_status_progresses ON ari.reservations;
CREATE TRIGGER reservation_status_progresses
  BEFORE UPDATE OF status ON ari.reservations
  FOR EACH ROW EXECUTE FUNCTION ari.reservation_status_progresses();

-- ---------------------------------------------------------------------------
-- 2. One claim per (agent, key, dimension), so a request can be held against a day
--    and a month at the same time.
-- ---------------------------------------------------------------------------

-- Both names are dropped before either is added: this file is re-applied by every test
-- run, and an `ADD CONSTRAINT` that assumes it is the first time is not a migration.
ALTER TABLE ari.reservations DROP CONSTRAINT IF EXISTS reservations_agent_id_idempotency_key_key;
ALTER TABLE ari.reservations DROP CONSTRAINT IF EXISTS reservations_claim_per_dimension;
ALTER TABLE ari.reservations
  ADD CONSTRAINT reservations_claim_per_dimension UNIQUE (agent_id, idempotency_key, dimension);

-- A retry looks its own claim up by key and dimension; reconciliation looks a request's
-- holds up by request. Both were being served by a sequential scan.
CREATE INDEX IF NOT EXISTS reservations_request_idx
  ON ari.reservations (org_id, request_id, status);

-- ---------------------------------------------------------------------------
-- 3. Indexes for the reads the live path actually issues.
-- ---------------------------------------------------------------------------

-- `replay()` joins decisions → tickets on `decision_id`; the only ticket index that
-- existed was partial on `redeemed_at IS NULL` and keyed by wallet.
CREATE INDEX IF NOT EXISTS signing_tickets_decision_idx
  ON ari.signing_tickets (decision_id);

-- The join from a request to its decisions supplies no `org_id`, so the leading column
-- of `authorization_decisions_request_idx (org_id, request_id, made_at)` was unusable.
CREATE INDEX IF NOT EXISTS authorization_decisions_request_id_idx
  ON ari.authorization_decisions (request_id);

-- The hourly velocity count filters `agent_id` inside an `(org_id, created_at)` range
-- scan: one org's whole hour of traffic read per request.
CREATE INDEX IF NOT EXISTS transaction_requests_agent_time_idx
  ON ari.transaction_requests (org_id, agent_id, created_at DESC);

-- `existingApproval()` asks for the open approval on a subject; the UNIQUE key has
-- `subject_kind` in the middle, so it cannot serve a lookup by `(org_id, subject_id)`.
CREATE INDEX IF NOT EXISTS approval_requests_subject_idx
  ON ari.approval_requests (org_id, subject_id, status, created_at DESC);

-- The risk baseline reads one agent's authorised history in a window. Partial, on
-- exactly the states that count as behaviour — `transaction_requests_recipient_idx`
-- excludes `TICKET_MINTED`, so it cannot serve this and is not reused.
CREATE INDEX IF NOT EXISTS transaction_requests_observed_idx
  ON ari.transaction_requests (org_id, agent_id, wallet_id, created_at DESC)
  WHERE lifecycle_state IN ('TICKET_MINTED', 'SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED');

-- The chain head: `ORDER BY seq DESC LIMIT 1` per org, on every append.
CREATE INDEX IF NOT EXISTS audit_events_head_idx
  ON ari.audit_events (org_id, seq DESC);

-- ---------------------------------------------------------------------------
-- 4. A published policy version cannot be walked back into a draft to be rewritten.
--    Allowed: DRAFT→ACTIVE, ACTIVE→SUPERSEDED, SUPERSEDED→ACTIVE (a justified
--    reactivation, §7.3), and either live status →RETIRED, which is terminal.
--
--    `005` freezes the content of any version whose status is not DRAFT, but status
--    itself was not part of a state machine, and `ari_app` holds UPDATE on the table.
--    So `SET status = 'DRAFT'` — a change the trigger's own WHEN clause then excludes —
--    made the content editable in the next statement. The immutability an auditor is
--    told about has to be the thing the database enforces, not the thing a cache
--    assumes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ari.policy_version_status_progresses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED' THEN
    RETURN NEW;
  END IF;
  -- Reactivation of an older version is allowed and expensive (§7.3): it is the one
  -- step that reads backwards, and `policies` makes it carry a justification.
  IF OLD.status = 'SUPERSEDED' AND NEW.status = 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  -- Retirement is a one-way door, which is the point: it is the only status with no way
  -- back, and so the one transition that cannot be used to make a published document
  -- editable again.
  IF OLD.status IN ('ACTIVE', 'SUPERSEDED') AND NEW.status = 'RETIRED' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'policy version % is %; it does not become %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS policy_version_status_progresses ON ari.policy_versions;
CREATE TRIGGER policy_version_status_progresses
  BEFORE UPDATE OF status ON ari.policy_versions
  FOR EACH ROW EXECUTE FUNCTION ari.policy_version_status_progresses();
