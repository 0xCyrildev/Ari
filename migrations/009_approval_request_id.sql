-- The request an approval belongs to, on the approval row.
--
-- §8 binds the token over `request_id ‖ digest ‖ …`, and `006` stored the subject
-- but not the request — so a token could not be reconstructed from the row that
-- records the approval. `subject_id` answers "what was approved"; `request_id`
-- answers "which presentation of it". They are the same value for a transaction and
-- different for anything else, which is the reason both exist.

ALTER TABLE ari.approval_requests ADD COLUMN IF NOT EXISTS request_id text;

UPDATE ari.approval_requests SET request_id = subject_id WHERE request_id IS NULL;
ALTER TABLE ari.approval_requests ALTER COLUMN request_id SET NOT NULL;
