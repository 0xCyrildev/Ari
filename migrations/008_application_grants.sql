-- What the application role may write.
--
-- `001` and `002` were exercised through privileged test connections and `003`
-- granted them only SELECT, so none of it was checked against the credential the
-- service actually runs as. The pipeline is the first code to reserve a limit and
-- record a decision *as ari_app*, and it failed immediately — which is the point of
-- running the whole path as the unprivileged role rather than as the table owner.
--
-- The shape of the grant is deliberate: INSERT and SELECT on the ledger, UPDATE on
-- the two tables whose rows must advance in place under a row lock, and nothing at
-- all on `organizations` beyond what tenancy creation needs. Audit stays
-- INSERT/SELECT-only (`003`) and reservations can never be *deleted*, only released
-- by setting a status — a role that could remove a row could remove the evidence.
GRANT USAGE ON SCHEMA ari TO ari_app;

GRANT SELECT, INSERT, UPDATE ON ari.limit_counters TO ari_app;
GRANT SELECT, INSERT, UPDATE ON ari.reservations TO ari_app;
GRANT SELECT, INSERT ON ari.authorization_decisions TO ari_app;
GRANT SELECT, INSERT, UPDATE ON ari.signing_tickets TO ari_app;

-- The decision and reservation tables are read by reconciliation and by the drift
-- checker, both of which run as the application role.
GRANT SELECT ON ari.organizations TO ari_app;
