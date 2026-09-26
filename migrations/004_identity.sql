-- Tenancy, identities and the objects a policy binds to.
--
-- Two rules run through this file. The first is §7.3's: nothing that represents a
-- decision about authority is edited in place — rows are superseded, so a question
-- asked in March can be answered from what was true in March. The second is T20's:
-- the tenant boundary is enforced here as well as in the application, because
-- "the repository layer always filters by org" is a convention, and conventions do
-- not survive the one query someone writes in a hurry.

CREATE SCHEMA IF NOT EXISTS ari;

CREATE TABLE IF NOT EXISTS ari.organizations (
  id         text        NOT NULL PRIMARY KEY,
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ari.users (
  id            text        NOT NULL PRIMARY KEY,
  org_id        text        NOT NULL REFERENCES ari.organizations (id),
  -- Lower-cased at the boundary, like every address Ari stores: a unique index on
  -- an un-normalised string is a unique index that two spellings of one person
  -- walk straight through.
  email         text        NOT NULL CHECK (email = lower(email)),
  display_name  text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status        text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

-- Roles are a membership property, not a user property: the same human can be an
-- approver in one organisation and a viewer in another.
CREATE TABLE IF NOT EXISTS ari.memberships (
  user_id  text NOT NULL REFERENCES ari.users (id) ON DELETE CASCADE,
  org_id   text NOT NULL REFERENCES ari.organizations (id),
  role     text NOT NULL CHECK (role IN ('owner', 'admin', 'approver', 'viewer')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id, role)
);

CREATE TABLE IF NOT EXISTS ari.agents (
  id         text        NOT NULL PRIMARY KEY,
  org_id     text        NOT NULL REFERENCES ari.organizations (id),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- PAUSED and REVOKED are reached by name, never by deleting the row: an agent's
  -- history is the evidence for whoever is asking what it did.
  status     text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS agents_org_idx ON ari.agents (org_id, status);

-- Credentials. The secret never appears here in any form: `secret_hash` is an
-- Argon2id digest of (org-scoped pepper ‖ secret), and the pepper lives outside
-- this database, which is what T8 asks for — a stolen table is not a usable table.
--
-- `key_id` is public and is how a presented credential is looked up. Separating it
-- from the secret is A7: rotation, revocation and "which credential produced this
-- request" all need an identity that is not also the bearer token.
CREATE TABLE IF NOT EXISTS ari.agent_credentials (
  id            text        NOT NULL PRIMARY KEY,
  org_id        text        NOT NULL REFERENCES ari.organizations (id),
  agent_id      text        NOT NULL REFERENCES ari.agents (id),
  key_id        text        NOT NULL UNIQUE,
  secret_hash   text        NOT NULL,
  scopes        text[]      NOT NULL CHECK (cardinality(scopes) > 0),
  -- Mandatory expiry: a credential that cannot expire is not constructible, which
  -- is a smaller surface than a default someone has to remember to override.
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  rotation_of   text REFERENCES ari.agent_credentials (id),
  last_used_at  timestamptz,
  CONSTRAINT expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT revoked_after_creation
    CHECK (revoked_at IS NULL OR revoked_at > created_at)
);

CREATE INDEX IF NOT EXISTS credentials_agent_idx ON ari.agent_credentials (org_id, agent_id);

-- A wallet's guarantee is chosen once and cannot be walked back: converting a
-- zero-trust dWallet to shared is documented as irreversible by the vendor
-- (ASSUMPTIONS I16), so a row that let `mode` be updated would let the product
-- claim a guarantee it had already given away.
CREATE TABLE IF NOT EXISTS ari.wallets (
  id               text        NOT NULL PRIMARY KEY,
  org_id           text        NOT NULL REFERENCES ari.organizations (id),
  display_name     text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  mode             text        NOT NULL CHECK (mode IN ('delegated', 'user_gated')),
  signature_triple text        NOT NULL,
  provider         text        NOT NULL DEFAULT 'mock',
  address          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at    timestamptz
);

CREATE TABLE IF NOT EXISTS ari.agent_wallet_grants (
  agent_id          text NOT NULL REFERENCES ari.agents (id),
  wallet_id         text NOT NULL REFERENCES ari.wallets (id),
  org_id            text NOT NULL REFERENCES ari.organizations (id),
  policy_version_id text NOT NULL,
  granted_by        text NOT NULL,
  granted_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  PRIMARY KEY (agent_id, wallet_id)
);

-- One row per request the pipeline has seen, and the unique key that makes a retry
-- a retry rather than a second spend.
CREATE TABLE IF NOT EXISTS ari.transaction_requests (
  id              text        NOT NULL PRIMARY KEY,
  org_id          text        NOT NULL REFERENCES ari.organizations (id),
  agent_id        text        NOT NULL REFERENCES ari.agents (id),
  wallet_id       text        NOT NULL REFERENCES ari.wallets (id),
  idempotency_key text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  canonical       text        NOT NULL,
  digest          text        NOT NULL,
  lifecycle_state text        NOT NULL DEFAULT 'DRAFT',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS transaction_requests_org_idx ON ari.transaction_requests (org_id, created_at DESC);

-- A wallet's mode is written once. Not "changed with a warning" — changed at all.
CREATE OR REPLACE FUNCTION ari.reject_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode OR NEW.signature_triple IS DISTINCT FROM OLD.signature_triple THEN
    RAISE EXCEPTION 'wallet % guarantee is immutable: % -> % is not a config change',
      OLD.id, OLD.mode, NEW.mode
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wallets_mode_immutable ON ari.wallets;
CREATE TRIGGER wallets_mode_immutable
  BEFORE UPDATE ON ari.wallets
  FOR EACH ROW EXECUTE FUNCTION ari.reject_mode_change();

-- ---------------------------------------------------------------------------
-- Tenant isolation, below the application
--
-- Every tenant-bearing table is row-secured for the application role: a query that
-- forgets its org filter returns nothing rather than everything, and the
-- repository layer's required `orgId` argument is the first line of defence rather
-- than the only one. The session's tenant is set with `SET LOCAL` inside the same
-- transaction that reads, so it cannot outlive the unit of work it scopes.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'ari' AND c.relkind = 'r'
       AND c.relname IN ('users', 'agents', 'agent_credentials', 'wallets',
                         'agent_wallet_grants', 'transaction_requests', 'memberships')
  LOOP
    EXECUTE format('ALTER TABLE ari.%I ENABLE ROW LEVEL SECURITY', t.relname);
    -- Both policies are dropped before either is created: this file is re-run by
    -- every test worker, and a `CREATE POLICY` that assumes it is the first time is
    -- not a migration, it is a one-shot script.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON ari.%I', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON ari.%I', t.relname);
    -- `true` in the second argument: an unset tenant reads nothing, rather than
    -- erroring somewhere that has no way to know which query forgot to set it.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON ari.%I USING (org_id = current_setting(''ari.org_id'', true))',
      t.relname
    );
    EXECUTE format(
      'CREATE POLICY tenant_write ON ari.%I AS PERMISSIVE FOR INSERT WITH CHECK (org_id = current_setting(''ari.org_id'', true))',
      t.relname
    );
  END LOOP;
END
$$;

-- DELETE on memberships, not everywhere: a role change is a replace, and a tenant
-- that could DELETE an agent row would be a tenant that could erase the evidence
-- an audit chain is supposed to preserve. Revocation is a status change for that
-- reason, never a delete.
GRANT SELECT, INSERT, UPDATE ON ari.organizations, ari.users, ari.agents,
  ari.agent_credentials, ari.wallets, ari.agent_wallet_grants, ari.transaction_requests TO ari_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ari.memberships TO ari_app;
-- NOTE: `organizations` is deliberately outside the row-security list — an
-- organisation has no row to scope itself by, and the bootstrap path that creates
-- one runs as a different credential from tenant traffic (§5.6).

-- The one tenant-blind read in the system, and it is narrow on purpose:
-- authentication has to find a row before it knows which tenant the request
-- belongs to, and the row policies above refuse an unscoped read — correctly, and
-- fatally, unless something is exposed here. So this view carries the fields the
-- check needs and nothing that identifies a customer: no emails, no display names,
-- no agent names. The secret hash is in it because a hash under an
-- outside-the-database pepper is what T8 says is safe to have read.
CREATE OR REPLACE VIEW ari.credential_lookup AS
  SELECT c.id, c.org_id, c.agent_id, c.key_id, c.secret_hash, c.scopes,
         c.expires_at, c.revoked_at, a.status AS agent_status
    FROM ari.agent_credentials c
    JOIN ari.agents a ON a.id = c.agent_id;

GRANT SELECT ON ari.credential_lookup TO ari_app;
