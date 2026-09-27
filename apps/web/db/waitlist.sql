-- The waitlist table, on its own database.
--
-- Deliberately not in the repository's `migrations/`: every file there is re-applied by
-- tests/security/global-setup.ts against the Ari schema, and a public signup table has nothing
-- to do with the ledger. Apply it once, by hand, to whatever WAITLIST_DATABASE_URL names:
--
--   psql "$WAITLIST_DATABASE_URL" -f apps/web/db/waitlist.sql
--
-- The uniqueness is what makes the route's onConflictDoNothing a fact rather than an intention;
-- without it the same address becomes a row per refresh.
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
