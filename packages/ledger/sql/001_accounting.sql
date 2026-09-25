-- Ari limit accounting. The slice of the schema that makes CC3 (atomic
-- reservation) real; organisations, agents, policies and the audit chain arrive
-- with their own migrations.
--
-- Amounts are numeric, not bigint. A raw wei or satoshi total routinely exceeds
-- 2^63-1, and a column that silently overflows a money counter is worse than no
-- column at all. Node's driver hands numeric back as a string, which is the
-- shape the rest of Ari expects at a serialisation boundary anyway.

CREATE SCHEMA IF NOT EXISTS ari;

CREATE TABLE IF NOT EXISTS ari.limit_counters (
  org_id           text        NOT NULL,
  agent_id         text        NOT NULL,
  -- The window this row accounts for, e.g. '2026-09-25' for a UTC daily cap.
  window_key       text        NOT NULL,
  -- Which dimension of the policy this row bounds, e.g. 'daily_raw'.
  dimension        text        NOT NULL,
  current_reserved numeric(80, 0) NOT NULL DEFAULT 0,
  settled          numeric(80, 0) NOT NULL DEFAULT 0,
  settled_requests bigint      NOT NULL DEFAULT 0,
  reserved_requests bigint     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, agent_id, window_key, dimension),
  CONSTRAINT reserved_not_negative CHECK (current_reserved >= 0),
  CONSTRAINT settled_not_negative CHECK (settled >= 0)
);

-- One row per authorised reservation, and the join key between a decision and
-- the money it committed. `idempotency_key` is unique per agent so a retried
-- request finds its existing reservation instead of taking a second one.
CREATE TABLE IF NOT EXISTS ari.reservations (
  id                text           NOT NULL PRIMARY KEY,
  org_id            text           NOT NULL,
  agent_id          text           NOT NULL,
  request_id        text           NOT NULL,
  idempotency_key   text           NOT NULL,
  window_key        text           NOT NULL,
  dimension         text           NOT NULL,
  amount_raw        numeric(80, 0) NOT NULL CHECK (amount_raw > 0),
  -- The policy version whose limits authorised this hold. Recorded rather than
  -- implied: a cap that moved underneath an outstanding reservation has to be
  -- visible, or a downgrade (T7) silently re-bounds money that was already spent.
  policy_version_id text           NOT NULL,
  status            text           NOT NULL CHECK (status IN ('HELD', 'SETTLED', 'RELEASED')),
  created_at        timestamptz    NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  release_reason    text,
  UNIQUE (agent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS reservations_open_idx
  ON ari.reservations (org_id, agent_id, window_key, dimension)
  WHERE status = 'HELD';

CREATE OR REPLACE FUNCTION ari.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS limit_counters_touch ON ari.limit_counters;
CREATE TRIGGER limit_counters_touch
  BEFORE UPDATE ON ari.limit_counters
  FOR EACH ROW EXECUTE FUNCTION ari.touch_updated_at();
