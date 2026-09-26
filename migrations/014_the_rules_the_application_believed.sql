-- The remaining rules the application believes and the schema does not hold.
--
-- `011` and `012` each closed one instance of this shape, and each time the surprise was
-- that the gap had been invisible: every test green, because the tests go through the code
-- that remembers the rule. Found by asking the schema a different question — "if something
-- other than `packages/` wrote this row, would anything refuse it?" — these are the six
-- that survived the asking.
--
-- None of them is reachable through Ari's own API today. That is the definition of a
-- convention here, and the reason they are worth closing before the surface widens: a
-- support script, a migration, a restore into a different tenant, or a compromised
-- application role talking SQL. The security model of this system is that Postgres is the
-- last authority; that claim is only worth what the last table enforces.

-- ---------------------------------------------------------------------------
-- 1. A credential could be un-revoked, and its authority edited in place.
--
--    `revokeCredential` and `rotateCredential` CAS on `revoked_at IS NULL`, and nothing
--    stopped the inverse: `UPDATE ari.agent_credentials SET revoked_at = NULL`. S14 says a
--    credential stops working the moment the agent is retired and that revocation is
--    permanent — "cannot un-revoke a retired agent, which is what 'revoked' has to mean" is
--    a test in `identity.test.ts`, and it tests the TypeScript. A revocation that a second
--    statement can undo is not a revocation.
--
--    The same argument covers the fields that *define* what the secret authorises. Rotating
--    `secret_hash` in place would leave one bearer id pointing at two different secrets over
--    time, which makes "revoke the leaked one" unanswerable — the state rotation was invented
--    to end. Widening `scopes` in place puts authority on a row that an audit trail describes
--    as it was at issuance. So the rule is the one `012` chose for tickets: a credential is
--    minted, used, and revoked; the only forward writes are `revoked_at` (NULL to a
--    timestamp) and `last_used_at`. A new capability is a new row, and a new row is the one
--    that gets an event.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ari.credential_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  subject text := TG_ARGV[0];
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'credential % was revoked at % and does not become live again', OLD.id, OLD.revoked_at
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.secret_hash      IS DISTINCT FROM OLD.secret_hash
     OR NEW.key_id         IS DISTINCT FROM OLD.key_id
     OR NEW.org_id         IS DISTINCT FROM OLD.org_id
     OR NEW.scopes         IS DISTINCT FROM OLD.scopes
     OR NEW.created_at     IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at     IS DISTINCT FROM OLD.expires_at
     OR NEW.rotation_of    IS DISTINCT FROM OLD.rotation_of
     OR (to_jsonb(NEW) -> subject) IS DISTINCT FROM (to_jsonb(OLD) -> subject) THEN
    RAISE EXCEPTION 'credential % is not editable: what it authorises is fixed at issuance', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS credential_is_immutable ON ari.agent_credentials;
CREATE TRIGGER credential_is_immutable
  BEFORE UPDATE ON ari.agent_credentials
  FOR EACH ROW EXECUTE FUNCTION ari.credential_is_immutable('agent_id');

DROP TRIGGER IF EXISTS credential_is_immutable ON ari.user_credentials;
CREATE TRIGGER credential_is_immutable
  BEFORE UPDATE ON ari.user_credentials
  FOR EACH ROW EXECUTE FUNCTION ari.credential_is_immutable('user_id');

-- ---------------------------------------------------------------------------
-- 2. An approval request stayed editable after humans started voting on it.
--
--    `006` made the *votes* append-only and left the thing they approve freely writable:
--    the status trigger fires `BEFORE UPDATE OF status`, so while a request was `PENDING`
--    one statement could move `digest`, `amount_raw`, `quorum_needed` or `allowed_roles`
--    underneath the votes already cast. `spendApproval` then matches the *rewritten* digest,
--    which turns "a human approved this payment" into "a human approved some payment" — the
--    single most valuable substitution available in this system, because every other check
--    still passes afterwards.
--
--    The whole row is frozen except what the decision process itself writes: `status` and
--    `consumed_at`. If a payment changes, a new approval is opened — which is one INSERT, a
--    new digest, and a new set of humans being asked.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ari.approval_request_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subject_kind      IS DISTINCT FROM OLD.subject_kind
     OR NEW.subject_id      IS DISTINCT FROM OLD.subject_id
     OR NEW.request_id      IS DISTINCT FROM OLD.request_id
     OR NEW.org_id          IS DISTINCT FROM OLD.org_id
     OR NEW.digest          IS DISTINCT FROM OLD.digest
     OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id
     OR NEW.agent_id        IS DISTINCT FROM OLD.agent_id
     OR NEW.wallet_id       IS DISTINCT FROM OLD.wallet_id
     OR NEW.amount_raw      IS DISTINCT FROM OLD.amount_raw
     OR NEW.currency_unit   IS DISTINCT FROM OLD.currency_unit
     OR NEW.quorum_needed   IS DISTINCT FROM OLD.quorum_needed
     OR NEW.allowed_roles   IS DISTINCT FROM OLD.allowed_roles
     OR NEW.requested_by    IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at      IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'approval % is not editable: its humans are already voting on these bytes', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approval_request_is_immutable ON ari.approval_requests;
CREATE TRIGGER approval_request_is_immutable
  BEFORE UPDATE ON ari.approval_requests
  FOR EACH ROW EXECUTE FUNCTION ari.approval_request_is_immutable();

-- ---------------------------------------------------------------------------
-- 3. A vote was a claim about an authority, not a record of one.
--
--    `approvals.approver_user_id` names no row and `role` matches nothing, so
--    `INSERT INTO ari.approvals` — a statement the application role is granted — ×
--    `quorum_needed` reaches `GRANTED` with no human involved at all. `006:43` documents
--    `role` as "recorded, not consulted", which is true of the *read* path and was never
--    true of the count that decides.
--
--    Validated at insert, in the shape `002` already uses for a ticket and its decision:
--    the vote's role is one the request asked for, the membership that role rests on
--    exists in this organisation, the bytes voted on are the bytes requested, the request
--    is still open, and the proposer of a policy change is not one of its approvers (T19,
--    now in the database rather than only in `recordDecision`). Deliberately *not* a
--    foreign key from `role` to the live membership: a person who voted must stay
--    demotable afterwards, and a reference that outlives the decision would make
--    "remove this approver" fail three months later on a row nobody can delete.
-- ---------------------------------------------------------------------------

ALTER TABLE ari.approvals DROP CONSTRAINT IF EXISTS approvals_approver_user_id_fkey;
ALTER TABLE ari.approvals
  ADD CONSTRAINT approvals_approver_user_id_fkey
  FOREIGN KEY (approver_user_id) REFERENCES ari.users (id);

CREATE OR REPLACE FUNCTION ari.approval_vote_is_authorized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request      record;
  holds_role   boolean;
BEGIN
  SELECT subject_kind, digest, allowed_roles, status, requested_by
    INTO request
    FROM ari.approval_requests
   WHERE id = NEW.approval_request_id;

  IF request.subject_kind IS NULL THEN
    RAISE EXCEPTION 'approval vote % names no request', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF request.status <> 'PENDING' THEN
    RAISE EXCEPTION 'approval % is %; a vote does not join a decision already made',
      NEW.approval_request_id, request.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (NEW.role = ANY (request.allowed_roles)) THEN
    RAISE EXCEPTION 'approval % asks for %, not %', NEW.approval_request_id, request.allowed_roles, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM ari.memberships m
     WHERE m.user_id = NEW.approver_user_id AND m.org_id = NEW.org_id AND m.role = NEW.role
  ) INTO holds_role;
  IF NOT holds_role THEN
    RAISE EXCEPTION 'user % does not hold % in this organisation', NEW.approver_user_id, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.digest IS DISTINCT FROM request.digest THEN
    RAISE EXCEPTION 'approval % was granted against bytes other than the request''s', NEW.approval_request_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF request.subject_kind = 'policy_activation' AND NEW.approver_user_id = request.requested_by THEN
    RAISE EXCEPTION 'user % proposed the change in approval % and cannot be its approver',
      NEW.approver_user_id, NEW.approval_request_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approval_vote_is_authorized ON ari.approvals;
CREATE TRIGGER approval_vote_is_authorized
  BEFORE INSERT ON ari.approvals
  FOR EACH ROW EXECUTE FUNCTION ari.approval_vote_is_authorized();

-- ---------------------------------------------------------------------------
-- 4. A window's key and its dimension were two unrelated strings.
--
--    `daily_*` windows are keyed by day and `monthly_*` by month, and the TypeScript is the
--    only thing that knows: `authorize` formats each one, and both the reservation's
--    `(agent, key, dimension)` claim and the counter's guarded update use the pair as if it
--    were one fact. A `monthly_raw` counter keyed `2026-10-05` is a *parallel* row — a second
--    month that nobody reads — so `current_reserved + settled <= max` keeps passing against a
--    number that no longer contains the month's spending, and the cap silently stops binding.
--    `verifyCounterIntegrity` would report it as healthy: it derives from the same pair.
-- ---------------------------------------------------------------------------

ALTER TABLE ari.reservations DROP CONSTRAINT IF EXISTS reservations_window_matches_dimension;
ALTER TABLE ari.reservations
  ADD CONSTRAINT reservations_window_matches_dimension
  CHECK (
    (dimension LIKE 'daily%'   AND window_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') OR
    (dimension LIKE 'monthly%' AND window_key ~ '^[0-9]{4}-[0-9]{2}$')
  );

ALTER TABLE ari.limit_counters DROP CONSTRAINT IF EXISTS limit_counters_window_matches_dimension;
ALTER TABLE ari.limit_counters
  ADD CONSTRAINT limit_counters_window_matches_dimension
  CHECK (
    (dimension LIKE 'daily%'   AND window_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') OR
    (dimension LIKE 'monthly%' AND window_key ~ '^[0-9]{4}-[0-9]{2}$')
  );

-- ---------------------------------------------------------------------------
-- 5. A person could hold two roles in one organisation, and every reader picked one.
--
--    `memberships` is keyed `(user_id, org_id, role)`, so owner-and-viewer is a legal state,
--    while `changeUserRole` deletes then inserts as if it were not, and both `roleOf`
--    implementations read `rows[0]` with no `ORDER BY` at all. Under `exactOptionalPropertyTypes`
--    and a live database, "an extra owner row" is not a hypothetical: it is one INSERT away,
--    and whether the application then sees owner or viewer depends on which row the scan
--    returns first. One role per person per organisation is the model the code has; the
--    second one is a deliberate migration when it changes.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_role_per_org
  ON ari.memberships (user_id, org_id);

-- ---------------------------------------------------------------------------
-- 6. A published policy could be walked back into effect with nothing written down.
--
--    `005` froze the content of any version that is not DRAFT and `010` put a machine on the
--    status, so the remaining move was the one §7.3 calls expensive: `SUPERSEDED → ACTIVE`.
--    `policies` requires a justification when the version being restored is *lower* than the
--    incumbent. When nothing is active at all — every version superseded or retired — it
--    required nothing, and the older document returned as the authority on an organisation's
--    money with no reason recorded anywhere. That is the least defensible activation in the
--    set and it was the free one.
--
--    The database now requires a written reason for every reactivation, which is a floor and
--    not a full answer: it cannot tell a fresh justification from the text the row already
--    carried, and neither could a rule written at the application layer without recording the
--    reason per transition. What it does close is the silent case — a reactivation with no
--    sentence attached, by any writer.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ari.policy_version_status_progresses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'SUPERSEDED' AND NEW.status = 'ACTIVE' THEN
    IF NEW.justification IS NULL OR length(btrim(NEW.justification)) < 10 THEN
      RAISE EXCEPTION 'policy version % is being reactivated; a written justification is required', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('ACTIVE', 'SUPERSEDED') AND NEW.status = 'RETIRED' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'policy version % is %; it does not become %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Two constraints that contradicted the code above them, both found while testing
--    the ones above.
--
--    `011` said an approval can record "no amount" — a valueless contract call moves no
--    token, and inventing a zero for it would read as "this payment is free" to the same
--    later sum that invented it. It dropped the `> 0` CHECK and added
--    `amount_raw IS NULL OR amount_raw >= 0`. It did not drop the column's `NOT NULL`,
--    which `006` had written on the line above. So the type said `bigint | null`, the
--    insert said `null`, and the database said no: escalating a contract call to a human
--    raised a not-null violation, rolled the transaction back, and left no decision and no
--    audit event — the same failure `010` was written to end, arriving from a migration that
--    had already declared itself finished. A CHECK that permits a value a column cannot hold
--    is not a relaxation; it is a promise nobody kept.
--
--    `revoked_at > created_at` has the same shape one level down. `revoked_at` is written by
--    `now()`, and inside the transaction that minted the credential `now()` *equals*
--    `created_at` — Postgres fixes `now()` at the start of the transaction. So revoking a
--    credential in the same transaction as issuing it, which is exactly what an operator
--    does when they catch a mistyped scope a second later, is refused by a constraint that
--    reads as if it forbids something else entirely. "Not dated before" is the rule; `>=` is
--    how it is written.
-- ---------------------------------------------------------------------------

ALTER TABLE ari.approval_requests ALTER COLUMN amount_raw DROP NOT NULL;

ALTER TABLE ari.user_credentials DROP CONSTRAINT IF EXISTS user_credential_revoked_after_creation;
ALTER TABLE ari.user_credentials
  ADD CONSTRAINT user_credential_revoked_after_creation
  CHECK (revoked_at IS NULL OR revoked_at >= created_at);

ALTER TABLE ari.agent_credentials DROP CONSTRAINT IF EXISTS revoked_after_creation;
ALTER TABLE ari.agent_credentials
  ADD CONSTRAINT revoked_after_creation
  CHECK (revoked_at IS NULL OR revoked_at >= created_at);
