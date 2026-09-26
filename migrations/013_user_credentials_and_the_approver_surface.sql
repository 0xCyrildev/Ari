-- A human needs a credential, and the two kinds of subject must not share one secret.
--
-- Everything up to `012` could *escalate* a payment to a human and could not reach that
-- human. `authorize` returns an `approvalId`, `recordDecision` counts a vote from a user
-- id, and there is no path by which a person outside this process presents one. The
-- consequence is that the most important branch of the decision set —
-- `REQUIRE_HUMAN_APPROVAL` — resolves to "stuck", and the approval token that seals a
-- human's yes can only be minted by whoever already holds `APPROVAL_KEY`, which today
-- means the operator's own process. A policy that says "ask someone" and cannot ask
-- anyone is not a control; it is a delay.
--
-- The mechanism chosen is a second credential table rather than a session: no cookies, no
-- login flow, no browser state, nothing that could only be described by inventing Phase
-- 10's dashboard first. A bearer credential bound to a user, verified by the same
-- Argon2id-over-peppered-secret path that already guards agents, carries the same
-- properties that make the agent half defensible — hashed at rest, mandatory expiry,
-- revocation, rotation by superseding, and one shape of refusal at the boundary. When a
-- real session model arrives it will *mint one of these*; it will not replace this.
--
-- And the reason it is a separate table rather than a `subject_kind` column on
-- `agent_credentials`: the boundary Ari sells is that the subject which proposes a payment
-- and the subject which approves it are different. That has to be a fact about the row,
-- because `ari_app` holds UPDATE on both tables and a `WHERE` clause is a convention.

CREATE TABLE IF NOT EXISTS ari.user_credentials (
  id            text        NOT NULL PRIMARY KEY,
  org_id        text        NOT NULL REFERENCES ari.organizations (id),
  user_id       text        NOT NULL REFERENCES ari.users (id),
  -- Unique across the whole deployment, like an agent's: the lookup that authenticates a
  -- request happens before the tenant is known, and a `key_id` that is only unique per
  -- organisation would make that lookup a search across every tenant in the database.
  key_id        text        NOT NULL UNIQUE,
  secret_hash   text        NOT NULL,
  scopes        text[]      NOT NULL CHECK (cardinality(scopes) > 0),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  rotation_of   text REFERENCES ari.user_credentials (id),
  last_used_at  timestamptz,
  CONSTRAINT user_credential_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT user_credential_revoked_after_creation
    CHECK (revoked_at IS NULL OR revoked_at > created_at),
  -- The vocabulary is checked in the database, not only in TypeScript: `isScope` exists
  -- and nothing calls it, so a scope nobody spelled correctly today reads as "not granted"
  -- and tomorrow reads as whatever a wider check happens to allow.
  CONSTRAINT user_credential_scope_known
    CHECK (scopes <@ ARRAY[
      'transaction:read', 'policy:read', 'policy:activate', 'approval:decide',
      'agent:manage', 'wallet:manage', 'audit:read'
    ]::text[]),
  -- The load-bearing line. `transaction:request` is the power to *propose* a payment, and
  -- it belongs to an agent. A human credential that could propose and approve would put
  -- both sides of the boundary behind one secret — which is the exact shape this whole
  -- product exists to refuse, and it is why it is a CHECK and not a rule in the route
  -- handler that would have to remember it.
  CONSTRAINT user_credential_cannot_propose
    CHECK (NOT (scopes && ARRAY['transaction:request']::text[]))
);

CREATE INDEX IF NOT EXISTS user_credentials_user_idx ON ari.user_credentials (user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS user_credentials_org_idx  ON ari.user_credentials (org_id);

-- The mirror of the rule above, on the table that already existed: an agent may not be
-- granted the power to approve. There is nothing to backfill — `approval:decide` was
-- declared in `SCOPES` and never issued to anything, which is the honest way for a
-- constraint like this to arrive: it closes a door nobody has walked through yet, and it
-- closes it before the route on the other side of it exists.
ALTER TABLE ari.agent_credentials DROP CONSTRAINT IF EXISTS agent_credential_cannot_approve;
ALTER TABLE ari.agent_credentials
  ADD CONSTRAINT agent_credential_cannot_approve
  CHECK (NOT (scopes && ARRAY['approval:decide']::text[]));

-- Authentication cannot be tenant-scoped, because finding the row is how the tenant
-- becomes known. Same view shape as `004`'s, same reason: expose the fields the check
-- needs and no names, and accept that the value handed across tenants is already
-- peppered and hashed (T8).
CREATE OR REPLACE VIEW ari.user_credential_lookup AS
  SELECT c.id, c.org_id, c.user_id, c.key_id, c.secret_hash, c.scopes,
         c.expires_at, c.revoked_at, u.status AS user_status
    FROM ari.user_credentials c
    JOIN ari.users u ON u.id = c.user_id;

GRANT SELECT ON ari.user_credential_lookup TO ari_app;

ALTER TABLE ari.user_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ari.user_credentials;
DROP POLICY IF EXISTS tenant_write ON ari.user_credentials;
CREATE POLICY tenant_isolation ON ari.user_credentials
  USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.user_credentials FOR INSERT
  WITH CHECK (org_id = current_setting('ari.org_id', true));

-- No DELETE: a revoked credential is evidence that a credential existed and was stopped.
-- The same grant the agent table has, for the same reason.
GRANT SELECT, INSERT, UPDATE ON ari.user_credentials TO ari_app;

-- A suspended person is refused at the gate, by the view's own join — and the reason this
-- is worth stating is that `users.status` otherwise does nothing at all. `004` added the
-- column with a CHECK on its values and no reader anywhere, so "suspend this person"
-- would have been a database write with no security consequence: the credential keeps
-- working, the membership keeps resolving a role, and the operator believes they stopped
-- someone. Suspended users now fail verification the way a revoked agent does, and
-- `roleOf` inside the tenant transaction remains the authority on the *role*.
