-- A queryable recipient on the request row.
--
-- The digest is the authority on what a request *is*; this column exists because
-- "have we paid this address before" has to be answerable without decoding a
-- canonical blob per row. It is derived metadata, written from the same parsed
-- candidate the digest was computed over, and it is never the thing a decision is
-- bound to.

ALTER TABLE ari.transaction_requests
  ADD COLUMN IF NOT EXISTS recipient_address text,
  ADD COLUMN IF NOT EXISTS amount_raw numeric(80, 0),
  ADD COLUMN IF NOT EXISTS currency_unit text;

-- Novelty is about money that actually moved. A request that was denied, or that
-- the human never approved, does not make its recipient familiar.
CREATE INDEX IF NOT EXISTS transaction_requests_recipient_idx
  ON ari.transaction_requests (org_id, wallet_id, recipient_address, created_at)
  WHERE lifecycle_state IN ('SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED');
