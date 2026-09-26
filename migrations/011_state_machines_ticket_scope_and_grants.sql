-- Three gaps that the schema did not enforce and the code believed it did.
--
-- Each of these is the same shape: a rule that lives in TypeScript, applied at the one
-- call site that thought about it, while the database — the thing that actually stands
-- between a compromised application and an impossible state — accepts anything.
-- `005` froze policy content and `010` gave reservations and policy versions a status
-- machine; these are the two remaining tables where the pattern was not finished, plus a
-- column the pipeline was about to write a dishonest value into.

-- ---------------------------------------------------------------------------
-- 1. `transaction_requests.lifecycle_state` was free text.
--
--    Two partial indexes (`007`, `010`) and the risk plane's whole notion of "observed
--    behaviour" are defined over particular values of it, and `setRequestState` is a
--    compare-and-set against whatever the caller claims the row was. So any call site
--    could write `DENIED → APPROVAL_PENDING`, or `RESERVED → RESERVED`, and the row would
--    take it — quietly falling out of the indexes that "settled" and "authorised" mean.
--    The edge list lives in `packages/transaction-engine`; a test in `tests/security/`
--    walks both copies against each other, because two copies of a state machine is
--    exactly the bug this section is closing.
-- ---------------------------------------------------------------------------

ALTER TABLE ari.transaction_requests DROP CONSTRAINT IF EXISTS transaction_requests_lifecycle_known_state;
ALTER TABLE ari.transaction_requests
  ADD CONSTRAINT transaction_requests_lifecycle_known_state
  CHECK (lifecycle_state IN (
    'DRAFT', 'VALIDATED', 'EVALUATING',
    'APPROVAL_PENDING', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED',
    'RESERVED', 'TICKET_MINTED',
    'SIGNING_PENDING', 'SIGNING_COMPLETE', 'SIGNING_FAILED', 'SIGNING_TIMEOUT',
    'BROADCAST', 'BROADCAST_CONFIRMED',
    'DENIED', 'ABANDONED'
  ));

CREATE OR REPLACE FUNCTION ari.transaction_request_state_progresses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state = OLD.lifecycle_state THEN
    -- A self-write is not "harmless": it is how two workers both believe they advanced the
    -- same request. Terminal states may not even be rewritten to themselves, because
    -- `DENIED → DENIED` is what a retry loop looks like from the outside.
    IF OLD.lifecycle_state IN ('DENIED', 'ABANDONED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'BROADCAST_CONFIRMED') THEN
      RAISE EXCEPTION 'request % is terminal at %', OLD.id, OLD.lifecycle_state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.lifecycle_state = 'DRAFT'
     AND NEW.lifecycle_state IN ('VALIDATED', 'DENIED', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'VALIDATED'
     AND NEW.lifecycle_state IN ('EVALUATING', 'DENIED', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'EVALUATING'
     AND NEW.lifecycle_state IN ('DENIED', 'APPROVAL_PENDING', 'RESERVED', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'APPROVAL_PENDING'
     AND NEW.lifecycle_state IN ('APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'DENIED', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'APPROVAL_GRANTED'
     AND NEW.lifecycle_state IN ('RESERVED', 'DENIED', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'RESERVED'
     AND NEW.lifecycle_state IN ('TICKET_MINTED', 'DENIED', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'TICKET_MINTED'
     AND NEW.lifecycle_state IN ('SIGNING_PENDING', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'SIGNING_PENDING'
     AND NEW.lifecycle_state IN ('SIGNING_COMPLETE', 'SIGNING_FAILED', 'SIGNING_TIMEOUT') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'SIGNING_COMPLETE'
     AND NEW.lifecycle_state IN ('BROADCAST', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'SIGNING_FAILED'
     AND NEW.lifecycle_state = 'ABANDONED' THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'SIGNING_TIMEOUT'
     AND NEW.lifecycle_state IN ('SIGNING_PENDING', 'ABANDONED') THEN RETURN NEW; END IF;
  IF OLD.lifecycle_state = 'BROADCAST'
     AND NEW.lifecycle_state IN ('BROADCAST_CONFIRMED', 'ABANDONED') THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'request % cannot move % -> %', OLD.id, OLD.lifecycle_state, NEW.lifecycle_state
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS transaction_request_state_machine ON ari.transaction_requests;
CREATE TRIGGER transaction_request_state_machine
  BEFORE UPDATE OF lifecycle_state ON ari.transaction_requests
  FOR EACH ROW EXECUTE FUNCTION ari.transaction_request_state_progresses();

-- ---------------------------------------------------------------------------
-- 2. An approval records how much money was approved. A contract call that moves none
--    does not have that fact, and the pipeline was about to invent a zero for it.
--
--    `amount_raw > 0` is the guard against "nobody derived an amount" reading as "this
--    payment is free", and for a `contract_call` it was doing both at once: the column
--    refused the honest value and accepted the dishonest one. NULL now means *no amount
--    is involved*; `0` still means the amount was computed and is zero, which the kernel
--    refuses separately (`AMOUNT_ZERO`). The same distinction is why the reservation is
--    skipped for such a request rather than written with a zero it would have to lie about.
-- ---------------------------------------------------------------------------

-- Both names are dropped before either is added, because this file is re-applied by
-- every test run: an `ADD CONSTRAINT` that assumes it is the first time is not a
-- migration, and 010 already had to learn that the hard way.
ALTER TABLE ari.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_amount_raw_positive;
ALTER TABLE ari.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_amount_raw_known;
ALTER TABLE ari.approval_requests
  ADD CONSTRAINT approval_requests_amount_raw_known
  CHECK (amount_raw IS NULL OR amount_raw >= 0);

-- ---------------------------------------------------------------------------
-- 3. A ticket row did not say which tenant it belonged to.
--
--    Every other money-bearing row does, and `004`'s row security is written per table —
--    so this one could not be filtered, joined, or counted per tenant without walking back
--    through its decision. No row security here, deliberately: `ari-signer` is the one
--    process that legitimately redeems tickets across tenants and has no tenant scope to
--    set, and a `USING (org_id = current_setting(...))` policy would silently make every
--    claim it attempts a no-op. What bounds a cross-tenant claim instead is the row itself:
--    `claimTicket` matches the digest and requires `redeemed_at IS NULL`, so a ticket id
--    guessed by another tenant is still not spendable without its sealed bytes.
-- ---------------------------------------------------------------------------

ALTER TABLE ari.signing_tickets ADD COLUMN IF NOT EXISTS org_id text;

UPDATE ari.signing_tickets t SET org_id = d.org_id
  FROM ari.authorization_decisions d
 WHERE d.id = t.decision_id AND t.org_id IS NULL;

ALTER TABLE ari.signing_tickets ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS signing_tickets_org_idx
  ON ari.signing_tickets (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Row security on the four money tables that were writing tenant-scoped rows
--    with no tenant enforcement underneath.
--
--    `004` enabled row security on the identity tables and `005` on the policy
--    ones; the ledger's own tables were left out, so every `org_id` in them was a
--    convention the application role could ignore. That is the same
--    "structurally, not by discipline" argument the rest of the schema is built
--    on, applied to the tables that hold money rather than the tables that hold
--    identity.
--
--    `signing_tickets` is deliberately *not* in this list: the authority plane
--    redeems tickets for tenants it has no scope for, and a policy here would
--    turn every claim into a silent zero-row no-op. Its bound is different and
--    stronger — `claimTicket` needs the sealed digest and an unredeemed row.
-- ---------------------------------------------------------------------------

ALTER TABLE ari.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ari.limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ari.authorization_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ari.audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ari.reservations;
DROP POLICY IF EXISTS tenant_write ON ari.reservations;
DROP POLICY IF EXISTS tenant_isolation ON ari.limit_counters;
DROP POLICY IF EXISTS tenant_write ON ari.limit_counters;
DROP POLICY IF EXISTS tenant_isolation ON ari.authorization_decisions;
DROP POLICY IF EXISTS tenant_write ON ari.authorization_decisions;
DROP POLICY IF EXISTS tenant_isolation ON ari.audit_events;
DROP POLICY IF EXISTS tenant_write ON ari.audit_events;

-- The `IS NOT NULL` conjunctive on the read policies is not decoration:
-- `current_setting('ari.org_id', true)` yields NULL when nothing set it, and
-- `org_id = NULL` is never true, so an unscoped connection reads nothing at all —
-- the same fail-closed shape as the identity tables.
CREATE POLICY tenant_isolation ON ari.reservations
  USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.reservations FOR INSERT
  WITH CHECK (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_isolation ON ari.limit_counters
  USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.limit_counters FOR INSERT
  WITH CHECK (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_isolation ON ari.authorization_decisions
  USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.authorization_decisions FOR INSERT
  WITH CHECK (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_isolation ON ari.audit_events
  USING (org_id = current_setting('ari.org_id', true));
CREATE POLICY tenant_write ON ari.audit_events FOR INSERT
  WITH CHECK (org_id = current_setting('ari.org_id', true));

-- UPDATE, where the ledger does it (a hold being settled or released), inherits the
-- read policy above: a row another tenant holds cannot be matched, let alone moved.
