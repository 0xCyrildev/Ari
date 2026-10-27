-- 017 — the ticket names the bytes a signature will cover.
--
-- Until today a ticket carried `digest`: a hash over a canonical description of what the agent meant.
-- That is the right thing to bind a *policy decision* to, and it is the wrong thing to bind a
-- *signature* to, because a chain signs an envelope and nothing in the schema said which envelope the
-- authorisation was about. `apps/signer` was handed `{ticket, canonical}` — no bytes — so Invariant 3,
-- "the signing boundary enforces authorization against the chain artifact", had no referent to enforce.
--
-- These columns give it one. They are written at minting from the same construction the decision plane
-- used (`@ari/chain-evm`'s signing payload), and read back at delivery so a retry re-seals the original
-- artifact rather than a fresh interpretation of the candidate.
--
-- `tx_digest` is NULLABLE and the reason is stated in `@ari/chain-core`: on EVM the transaction hash
-- covers the signature, so it does not exist before signing. Storing the signing hash in that column
-- would give reconciliation a receipt lookup key that resolves to no receipt, forever, and a missing
-- receipt would read as a bug in the lookup rather than as the absence of a transaction.
--
-- `012` made a minted ticket immutable by permitting exactly one field to change after minting.
-- That trigger enumerated the old columns, so these five would have been editable — including
-- `signing_digest`, which is the thing the seal is about. Editing it does not amend an authorisation,
-- it forges a different one under a ticket id that already cleared policy. The function is therefore
-- recreated below to cover them, and it stays a single explicit list on purpose: a column added here
-- and not named there is a hole nobody would notice until it was used.

BEGIN;

ALTER TABLE ari.signing_tickets
  ADD COLUMN IF NOT EXISTS chain           text,
  ADD COLUMN IF NOT EXISTS signing_digest  text,
  ADD COLUMN IF NOT EXISTS tx_digest       text,
  ADD COLUMN IF NOT EXISTS bytes_sha256    text,
  ADD COLUMN IF NOT EXISTS byte_length     numeric(80,0);

-- Every ticket minted from now on must name them; existing rows are already-spent history and are
-- left NULL rather than backfilled with a guess about bytes nobody recorded. A NOT NULL here would
-- make this migration unreplayable against a database that already has tickets, and the test
-- database is never truncated between runs.
ALTER TABLE ari.signing_tickets DROP CONSTRAINT IF EXISTS signing_tickets_chain_known;
ALTER TABLE ari.signing_tickets ADD CONSTRAINT signing_tickets_chain_known
  CHECK (
    chain IS NULL
    OR (
      chain IN ('evm', 'sui', 'solana')
      -- The grammar is chain-core's `ChainTransactionDigest`: chain/algorithm:64-lowercase-hex. Case
      -- matters — base58 renderings lowercased into collisions, which is why the type is hex-only.
      AND signing_digest ~ '^(evm|sui|solana)/[a-z0-9-]+-v1:[0-9a-f]{64}$'
      AND (tx_digest IS NULL OR tx_digest ~ '^(evm|sui|solana)/[a-z0-9-]+-v1:[0-9a-f]{64}$')
      -- The tag must be about the chain the row claims. Without this, a row could seal a Sui digest
      -- under chain = 'evm' and the signer's adapter would be asked to check bytes it cannot read.
      AND split_part(signing_digest, '/', 1) = chain
      AND bytes_sha256 ~ '^[0-9a-f]{64}$'
      AND byte_length > 0
    )
  );

CREATE INDEX IF NOT EXISTS signing_tickets_chain_idx
  ON ari.signing_tickets (chain) WHERE chain IS NOT NULL;

-- Recreated from 012 with the new columns in the compared list. The rule is unchanged: after minting,
-- `redeemed_at` is the only field that may move, and only from NULL to a timestamp.
-- Identical to `012`'s function except for the five added columns: same three guards, same wording,
-- same error codes. A rewrite that quietly merged the expiry guard into the immutability list would
-- change what an operator reads when a ticket is tampered with, and `tests/security/decisions.test.ts`
-- asserts that wording.
CREATE OR REPLACE FUNCTION ari.signing_ticket_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id            IS DISTINCT FROM OLD.id
     OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
     OR NEW.org_id       IS DISTINCT FROM OLD.org_id
     OR NEW.wallet_id    IS DISTINCT FROM OLD.wallet_id
     OR NEW.digest       IS DISTINCT FROM OLD.digest
     OR NEW.chain        IS DISTINCT FROM OLD.chain
     OR NEW.signing_digest IS DISTINCT FROM OLD.signing_digest
     OR NEW.tx_digest    IS DISTINCT FROM OLD.tx_digest
     OR NEW.bytes_sha256 IS DISTINCT FROM OLD.bytes_sha256
     OR NEW.byte_length   IS DISTINCT FROM OLD.byte_length
     OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ticket % is not editable: what it authorises is fixed at minting', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

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

COMMIT;
