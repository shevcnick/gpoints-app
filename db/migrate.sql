-- Brings an existing database up to the current schema WITHOUT dropping anything.
-- Safe to run repeatedly. Use this on a database that has real users in it;
-- db/schema.sql drops every table and is only for a fresh start.

-- Reversals: admin can undo an approved transaction. The row is marked rather than
-- deleted, so the points come off but the history and the reason survive.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS reversed_at    timestamptz;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS reversed_by    integer REFERENCES users(id);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS reverse_reason text;

-- Allow the new 'reversed' status. The constraint name is whatever Postgres generated,
-- so find it rather than guessing.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'proposals'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE proposals DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
    CHECK (status IN ('open','approved','rejected','expired','reversed','cancelled'));
END $$;

-- Season standings gained an avatar column so past winners keep their emoji.
ALTER TABLE season_standings ADD COLUMN IF NOT EXISTS avatar_emoji text NOT NULL DEFAULT '🙂';

-- Recreate the ledger view so it matches the current definition. Only 'approved'
-- proposals count, which is what makes a reversal take effect immediately.
DROP VIEW IF EXISTS ledger;
CREATE VIEW ledger AS
  SELECT id, season_id, target_id AS user_id, proposer_id, kind, reason, resolved_at,
         CASE WHEN kind = 'award' THEN amount ELSE -amount END AS delta
  FROM proposals
  WHERE status = 'approved';

-- Indexes that may not exist on an older database.
CREATE INDEX IF NOT EXISTS proposals_open ON proposals (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS proposals_standing
  ON proposals (season_id, target_id, resolved_at) WHERE status = 'approved';

-- Discord voting: link an app account to a Discord user, and remember which message
-- carries a proposal's buttons so the tally can be edited in place.
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id   text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS discord_message_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_discord_id_key') THEN
    ALTER TABLE users ADD CONSTRAINT users_discord_id_key UNIQUE (discord_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS discord_link_codes (
  discord_id text PRIMARY KEY,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS discord_channel_id text;
