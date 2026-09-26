-- The audit trail: append-only in the database, not merely in application
-- discipline (§11, CC4, S10).
--
-- The threat this exists for is T18 — a compromised backend that can also write
-- — and the answer is not "the ORM never calls UPDATE". It is that the credential
-- the application runs as *cannot*, and that the shape of what it can append makes
-- a gap or an edit detectable rather than merely unlikely.

CREATE SCHEMA IF NOT EXISTS ari;

CREATE TABLE IF NOT EXISTS ari.audit_events (
  seq               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id                text        NOT NULL UNIQUE,
  org_id            text        NOT NULL,
  -- The chain. `prev_hash` is the hash of the previous event in this
  -- organisation's stream, or the genesis constant for the first.
  prev_hash         text        NOT NULL,
  hash              text        NOT NULL UNIQUE,
  actor             text        NOT NULL,
  actor_type        text        NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  event_type        text        NOT NULL,
  resource          text,
  resource_id       text,
  request_id        text,
  correlation_id    text,
  policy_version_id text,
  decision          text CHECK (decision IN ('ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL')),
  reason_codes      text[]      NOT NULL DEFAULT '{}',
  -- Constrained by the writer's `SafeLogFields` type, which has no field a secret
  -- fits into. JSONB because "what did the human see" is structured evidence,
  -- and the alternative — a free-text detail column — is where tokens leak.
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  made_at           timestamptz NOT NULL DEFAULT now(),
  -- Severity is stored, not inferred from the event type, so a query for
  -- "everything that widened someone's authority" does not depend on a list that
  -- will drift.
  severity          text NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info', 'notice', 'warning', 'critical')),
  CONSTRAINT chain_self_consistent CHECK (hash <> prev_hash)
);

CREATE INDEX IF NOT EXISTS audit_events_org_seq_idx ON ari.audit_events (org_id, seq);
CREATE INDEX IF NOT EXISTS audit_events_request_idx ON ari.audit_events (org_id, request_id);

-- A row, once written, does not change. This is the polite layer: it stops a bug
-- in the application. The role grants below are the layer that stops an attacker
-- who has the application's credential.
CREATE OR REPLACE FUNCTION ari.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON ari.audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON ari.audit_events
  FOR EACH ROW EXECUTE FUNCTION ari.reject_audit_mutation();

-- The gap detector, at the moment of writing rather than at review time.
--
-- An insert whose `prev_hash` does not match the current head is either a race
-- the writer failed to serialise or someone reconstructing history from a point
-- they should not be able to reach. Either way it is not silently appendable.
CREATE OR REPLACE FUNCTION ari.enforce_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head_hash text;
BEGIN
  SELECT hash INTO head_hash
    FROM ari.audit_events
   WHERE org_id = NEW.org_id
   ORDER BY seq DESC
   LIMIT 1;

  IF head_hash IS NULL THEN
    IF NEW.prev_hash <> 'genesis' THEN
      RAISE EXCEPTION 'first audit event for org % must chain from genesis', NEW.org_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.prev_hash <> head_hash THEN
    RAISE EXCEPTION 'audit chain break for org %: expected prev %', NEW.org_id, head_hash
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_chain ON ari.audit_events;
CREATE TRIGGER audit_events_chain
  BEFORE INSERT ON ari.audit_events
  FOR EACH ROW EXECUTE FUNCTION ari.enforce_audit_chain();

-- The application's credential. Cluster roles are shared and cannot be dropped by
-- an unprivileged migration, so this is written to be re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ari_app') THEN
    CREATE ROLE ari_app NOLOGIN NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA ari TO ari_app;
GRANT INSERT, SELECT ON ari.audit_events TO ari_app;
GRANT SELECT ON ari.limit_counters, ari.reservations TO ari_app;
-- nextval() needs USAGE, and nothing more: UPDATE on the identity sequence would
-- let the application credential rewind the ordering the chain depends on.
GRANT USAGE ON SEQUENCE ari.audit_events_seq_seq TO ari_app;

-- Stated as a revocation as well, because a future `GRANT ALL` somewhere else in
-- this series would otherwise be the quiet way back in.
REVOKE UPDATE, DELETE, TRUNCATE ON ari.audit_events FROM ari_app;
REVOKE ALL ON SCHEMA ari FROM ari_app;
GRANT USAGE ON SCHEMA ari TO ari_app;
