-- Decisions and tickets: the database half of "authorize before signing".
--
-- ARCHITECTURE §1 makes ordering the claim, and everything up to this file
-- enforces it in TypeScript. This file enforces it where a compromised or
-- buggy application cannot reach: a signing ticket may not exist unless an ALLOW
-- decision exists underneath it, and the digest in the ticket row is the digest
-- that decision was about.

CREATE TABLE IF NOT EXISTS ari.authorization_decisions (
  id                text      NOT NULL PRIMARY KEY,
  org_id            text      NOT NULL,
  request_id        text      NOT NULL,
  policy_version_id text      NOT NULL,
  outcome           text      NOT NULL CHECK (outcome IN ('ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL')),
  -- The bytes a decision was about. Required for the two outcomes that commit to
  -- something; absent for a DENY, which has nothing to be about and must still
  -- be recordable even when the canonicaliser refused the candidate.
  digest            text,
  made_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digest_present_when_it_commits
    CHECK (outcome = 'DENY' OR digest IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS authorization_decisions_request_idx
  ON ari.authorization_decisions (org_id, request_id, made_at DESC);

-- The ticket ledger: single use as a row, not as a flag on a string.
CREATE TABLE IF NOT EXISTS ari.signing_tickets (
  id          text        NOT NULL PRIMARY KEY,
  decision_id text        NOT NULL REFERENCES ari.authorization_decisions (id),
  digest      text        NOT NULL,
  wallet_id   text        NOT NULL,
  expires_at_ms bigint    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);

CREATE INDEX IF NOT EXISTS signing_tickets_open_idx
  ON ari.signing_tickets (wallet_id, digest)
  WHERE redeemed_at IS NULL;

-- The load-bearing statement. A trigger rather than a CHECK because it has to
-- read another table, and a foreign key alone would still allow a ticket pointing
-- at a DENY — which is the exact shape of "someone minted a ticket for a request
-- that was refused".
CREATE OR REPLACE FUNCTION ari.ticket_requires_allow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decision_outcome text;
  decision_digest  text;
BEGIN
  SELECT outcome, digest
    INTO decision_outcome, decision_digest
    FROM ari.authorization_decisions
   WHERE id = NEW.decision_id;

  IF decision_outcome IS DISTINCT FROM 'ALLOW' THEN
    RAISE EXCEPTION 'ticket % is not backed by an ALLOW decision (found %)', NEW.id, COALESCE(decision_outcome, 'no decision')
      USING ERRCODE = 'check_violation';
  END IF;

  IF decision_digest IS DISTINCT FROM NEW.digest THEN
    RAISE EXCEPTION 'ticket % seals a digest its decision was not about', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signing_tickets_require_allow ON ari.signing_tickets;
CREATE TRIGGER signing_tickets_require_allow
  BEFORE INSERT ON ari.signing_tickets
  FOR EACH ROW EXECUTE FUNCTION ari.ticket_requires_allow();
