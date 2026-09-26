-- Two rules that the application believed and the database did not hold.
--
-- Both are the same shape as everything else in this directory: a constraint stated in
-- TypeScript, enforced at the one call site that thought about it, while the table
-- accepts any statement from anything else that can write it — a support script, a
-- migration, or a compromised application plane talking SQL. `008` grants `ari_app`
-- UPDATE on `signing_tickets` because redeeming a ticket is an UPDATE, and the whole
-- single-use property sat in one `WHERE redeemed_at IS NULL`.

-- ---------------------------------------------------------------------------
-- 1. A redeemed ticket could be un-redeemed, and an authorised one could be rewritten.
--
--    `claimTicket` filters on `redeemed_at IS NULL AND expires_at_ms > now`, which is
--    correct as far as it goes: it is a read. The *write* that makes a ticket spent is
--    an ordinary UPDATE, and nothing stopped the inverse —
--
--      UPDATE ari.signing_tickets SET redeemed_at = NULL, expires_at_ms = <next year>
--
--    is one statement, from the role the service already holds, on the one tenant
--    table that has no row security (deliberately: `ari-signer` redeems across tenants).
--    It would be an untraceable second signature for a single authorisation, and the
--    ticket row is exactly the artifact that is supposed to make "this was spent" a fact
--    rather than a claim. `011` made the signer's cross-tenant access safe by giving it
--    nothing to rewrite; this closes what it left open.
--
--    The rule chosen is the strict one: after a ticket is minted, the only field that
--    may change is `redeemed_at`, and only from NULL to a timestamp. The columns that
--    *define what was authorised* — the digest, the wallet, the decision, the expiry —
--    are the ticket. Editing any of them does not amend an authorisation, it forges a
--    different one under an id that already cleared policy. Re-minting is one INSERT and
--    produces a decision row and an audit event; editing produces neither.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ari.signing_ticket_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id            IS DISTINCT FROM OLD.id
     OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
     OR NEW.org_id       IS DISTINCT FROM OLD.org_id
     OR NEW.wallet_id    IS DISTINCT FROM OLD.wallet_id
     OR NEW.digest       IS DISTINCT FROM OLD.digest
     OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ticket % is not editable: what it authorises is fixed at minting', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A seal is bounded by the window it states. Extending it in place would turn a
  -- 60-second capability into whatever the writer felt like, and the replay path — which
  -- re-seals from the *row's* stored expiry — would then honour a lifetime nobody
  -- decided.
  IF NEW.expires_at_ms IS DISTINCT FROM OLD.expires_at_ms THEN
    RAISE EXCEPTION 'ticket % seals an expiry of %; it is not moved to %',
      OLD.id, OLD.expires_at_ms, NEW.expires_at_ms
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.redeemed_at IS NOT NULL AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at THEN
    RAISE EXCEPTION 'ticket % was redeemed at % and does not become spendable again',
      OLD.id, OLD.redeemed_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signing_ticket_is_immutable ON ari.signing_tickets;
CREATE TRIGGER signing_ticket_is_immutable
  BEFORE UPDATE ON ari.signing_tickets
  FOR EACH ROW EXECUTE FUNCTION ari.signing_ticket_is_immutable();

-- ---------------------------------------------------------------------------
-- 2. `010` and the ledger disagreed about whether a released claim can be retried.
--
--    The ledger re-claims any reservation row that is not `HELD` or `SETTLED` — so it
--    adopts `RELEASED` claims — while `010`'s machine permitted only `ABANDONED →
--    PENDING`. The two are not merely inconsistent in the abstract: `authorize` releases
--    the daily hold when the *monthly* cap refuses (the honest thing to do, since the
--    day was never spent), and the agent's next attempt carries the same idempotency
--    key, which is the same claim, which the ledger then tried to move from `RELEASED`
--    to `PENDING` — and the trigger raised. A 500, a rolled-back audit row, and a cap
--    refusal that never got recorded: precisely the failure mode `010` was written to
--    eliminate, arriving by a different route.
--
--    The rule that is actually meant: a *dead* claim may be re-taken, and *money* never
--    re-enters a claim. `ABANDONED` (refused on capacity) and `RELEASED` (given back
--    after a signature that never happened) are both dead; `SETTLED` left the account
--    and `HELD` is somebody's live reservation, and neither is ever a starting point.
--    `resolved_at` and the counter move with the re-claim, so this is a new hold, not a
--    revived one — which is what the comment in `010` was reaching for when it said the
--    backwards step is only ever a re-claim.
-- ---------------------------------------------------------------------------

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
  IF OLD.status IN ('ABANDONED', 'RELEASED') AND NEW.status = 'PENDING' THEN
    -- Re-claimed by a later attempt on the same (agent, key, dimension). This is the
    -- only backwards step, and it is a new hold being taken rather than an old one
    -- being revived: no money moved while the row was dead, and the amount, request and
    -- window are all rewritten in the same statement.
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'reservation % is %; it does not become %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;
