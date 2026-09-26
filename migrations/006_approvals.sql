-- Approvals: a bound, one-time, expiring authority to proceed.
--
-- §8. An approval is not a checkbox with an ID, and the schema is where that
-- distinction becomes real: the vote is unique per person, the quorum is counted
-- under a row lock, the consumption is a single atomic claim, and the digest the
-- human looked at is stored alongside the record of them approving it.

CREATE TABLE IF NOT EXISTS ari.approval_requests (
  id                 text        NOT NULL PRIMARY KEY,
  org_id             text        NOT NULL REFERENCES ari.organizations (id),
  -- What is being approved. A transaction request and a policy activation need the
  -- same machinery and have different guards: nobody may approve the change that
  -- widens their own authority (T19), which only means something for the latter.
  subject_kind       text        NOT NULL CHECK (subject_kind IN ('transaction', 'policy_activation')),
  subject_id         text        NOT NULL,
  digest             text        NOT NULL,
  policy_version_id  text        NOT NULL,
  agent_id           text        NOT NULL,
  wallet_id          text        NOT NULL,
  amount_raw         numeric(80, 0) NOT NULL CHECK (amount_raw > 0),
  currency_unit      text        NOT NULL,
  quorum_needed      integer     NOT NULL CHECK (quorum_needed > 0),
  allowed_roles      text[]      NOT NULL CHECK (allowed_roles <> '{}'),
  requested_by       text        NOT NULL,
  expires_at         timestamptz NOT NULL,
  status             text        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'GRANTED', 'REJECTED', 'EXPIRED', 'CONSUMED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  consumed_at        timestamptz,
  -- One open approval per subject: a second escalation on the same request would be
  -- a second chance to satisfy the quorum, which is not the same thing as a quorum.
  UNIQUE (org_id, subject_kind, subject_id)
);

CREATE INDEX IF NOT EXISTS approval_requests_open_idx
  ON ari.approval_requests (org_id, status, expires_at);

CREATE TABLE IF NOT EXISTS ari.approvals (
  id                   text        NOT NULL PRIMARY KEY,
  approval_request_id  text        NOT NULL REFERENCES ari.approval_requests (id),
  org_id               text        NOT NULL REFERENCES ari.organizations (id),
  approver_user_id     text        NOT NULL,
  -- Recorded, not consulted: the check happens against the membership table at the
  -- moment of deciding, and this is what a reviewer reads afterwards.
  role                 text        NOT NULL,
  decision             text        NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  -- The exact bytes the approver was shown. If this ever disagrees with the
  -- request's digest, the approval was granted against a different transaction.
  digest               text        NOT NULL,
  decided_at           timestamptz NOT NULL DEFAULT now(),
  -- One human, one vote — enforced here rather than counted afterwards, because the
  -- race that matters is the same person clicking twice.
  UNIQUE (approval_request_id, approver_user_id)
);

-- A granted approval cannot have its quorum re-tallied by editing history: the
-- votes are append-only, the same rule the audit trail runs on.
CREATE OR REPLACE FUNCTION ari.reject_approval_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approvals are recorded once; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS approvals_append_only ON ari.approvals;
CREATE TRIGGER approvals_append_only
  BEFORE UPDATE OR DELETE ON ari.approvals
  FOR EACH ROW EXECUTE FUNCTION ari.reject_approval_edit();

-- Consumption is only legal from GRANTED. Postgres cannot express "the count of
-- another table's rows said yes" in a CHECK, so the state machine is enforced here:
-- anything that has not been tallied to quorum cannot be spent.
CREATE OR REPLACE FUNCTION ari.approval_status_progresses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('CONSUMED', 'REJECTED', 'EXPIRED') THEN
    RAISE EXCEPTION 'approval % is %; it does not change again', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'GRANTED' AND NEW.status <> 'CONSUMED' THEN
    RAISE EXCEPTION 'granted approval % can only be consumed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'CONSUMED' AND OLD.status <> 'GRANTED' THEN
    RAISE EXCEPTION 'approval % was %; only a granted approval can be consumed', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'GRANTED' THEN
    -- The tally is the authorisation. A status set by hand, without the votes
    -- behind it, would be a quorum that exists only in the column.
    PERFORM 1 FROM ari.approval_requests r
      WHERE r.id = NEW.id
        AND (SELECT count(*) FROM ari.approvals a
              WHERE a.approval_request_id = r.id AND a.decision = 'APPROVED') >= NEW.quorum_needed;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval % cannot become GRANTED without % matching votes', NEW.id, NEW.quorum_needed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approval_status_machine ON ari.approval_requests;
CREATE TRIGGER approval_status_machine
  BEFORE UPDATE OF status ON ari.approval_requests
  FOR EACH ROW EXECUTE FUNCTION ari.approval_status_progresses();

ALTER TABLE ari.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ari.approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ari.approval_requests;
DROP POLICY IF EXISTS tenant_write ON ari.approval_requests;
DROP POLICY IF EXISTS tenant_isolation ON ari.approvals;
DROP POLICY IF EXISTS tenant_write ON ari.approvals;

CREATE POLICY tenant_isolation ON ari.approval_requests USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.approval_requests FOR INSERT WITH CHECK (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_isolation ON ari.approvals USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.approvals FOR INSERT WITH CHECK (org_id = current_setting('ari.org_id', true));

GRANT SELECT, INSERT, UPDATE ON ari.approval_requests TO ari_app;
GRANT SELECT, INSERT ON ari.approvals TO ari_app;
