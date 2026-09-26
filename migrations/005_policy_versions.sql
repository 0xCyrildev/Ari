-- Policy versions: immutable content, progressing status, one active at a time.
--
-- §7.3 and S9. A decision made in March has to be re-derivable in September, which
-- means the document that produced it cannot be edited afterwards — and "cannot"
-- here means the row refuses, not that the API does not offer an edit button,
-- because T7's whole point is that rewriting a published policy is the most
-- efficient attack on this system.

CREATE TABLE IF NOT EXISTS ari.policies (
  id         text        NOT NULL PRIMARY KEY,
  org_id     text        NOT NULL REFERENCES ari.organizations (id),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ari.policy_versions (
  id              text        NOT NULL PRIMARY KEY,
  policy_id       text        NOT NULL REFERENCES ari.policies (id),
  org_id          text        NOT NULL REFERENCES ari.organizations (id),
  version_number  integer     NOT NULL CHECK (version_number > 0),
  -- The authoring document, with big integers as decimal strings. Nothing in the
  -- evaluation path reads this shape (A4): it is kept as the evidence of what was
  -- proposed, and compiled at activation.
  document        jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED')),
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  activated_by    text,
  -- Required whenever an older version is brought back. The text is not decoration:
  -- it is what the high-severity audit event carries, and what a reviewer reads to
  -- decide whether the rollback was a rollback or a widening.
  justification   text,
  UNIQUE (policy_id, version_number)
);

-- Exactly one active version per policy, enforced where a race would otherwise put
-- two of them in place at once.
CREATE UNIQUE INDEX IF NOT EXISTS policy_versions_one_active_idx
  ON ari.policy_versions (policy_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS policy_versions_org_idx ON ari.policy_versions (org_id, policy_id, version_number);

-- Content is frozen the moment a version leaves DRAFT; status may still progress.
-- The distinction matters: a blanket "no UPDATE on published rows" would make
-- activation impossible, and "activation is a status change" is the only honest way
-- to put it.
CREATE OR REPLACE FUNCTION ari.reject_policy_content_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document IS DISTINCT FROM OLD.document
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     -- A justification is part of a transition, not part of a version. §7.3 asks
     -- for one when an *older* version is brought back, and that row is by then
     -- SUPERSEDED — so freezing the column unconditionally would forbid the very
     -- act the rule is there to make expensive. It may change only in the same
     -- statement that changes status, and never on its own.
     OR (
       NEW.justification IS DISTINCT FROM OLD.justification
       AND NEW.status IS NOT DISTINCT FROM OLD.status
     )
  THEN
    RAISE EXCEPTION 'policy version % is %; its content is immutable', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS policy_versions_immutable ON ari.policy_versions;
CREATE TRIGGER policy_versions_immutable
  BEFORE UPDATE ON ari.policy_versions
  FOR EACH ROW WHEN (OLD.status <> 'DRAFT')
  EXECUTE FUNCTION ari.reject_policy_content_change();

ALTER TABLE ari.policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ari.policy_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ari.policies;
DROP POLICY IF EXISTS tenant_write ON ari.policies;
DROP POLICY IF EXISTS tenant_isolation ON ari.policy_versions;
DROP POLICY IF EXISTS tenant_write ON ari.policy_versions;

CREATE POLICY tenant_isolation ON ari.policies USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.policies FOR INSERT WITH CHECK (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_isolation ON ari.policy_versions USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.policy_versions FOR INSERT WITH CHECK (org_id = current_setting('ari.org_id', true));

GRANT SELECT, INSERT, UPDATE ON ari.policies, ari.policy_versions TO ari_app;
