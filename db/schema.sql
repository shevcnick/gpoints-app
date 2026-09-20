-- G Points schema. Safe to re-run: drops and recreates everything.
-- Applied against local Postgres for dev, and against Neon for production.

DROP VIEW  IF EXISTS ledger            CASCADE;
DROP TABLE IF EXISTS season_standings  CASCADE;
DROP TABLE IF EXISTS votes             CASCADE;
DROP TABLE IF EXISTS proposals         CASCADE;
DROP TABLE IF EXISTS seasons           CASCADE;
DROP TABLE IF EXISTS users             CASCADE;

CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  display_name  text NOT NULL,
  avatar_emoji  text NOT NULL DEFAULT '🙂',
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  discord_id    text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Exactly one season has closed_at IS NULL at any time; that is the active one.
CREATE TABLE seasons (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);
CREATE UNIQUE INDEX one_active_season ON seasons ((closed_at IS NULL)) WHERE closed_at IS NULL;

-- A code handed to an unlinked Discord user so they can claim their app account.
CREATE TABLE discord_link_codes (
  discord_id text PRIMARY KEY,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE proposals (
  id          serial PRIMARY KEY,
  season_id   integer NOT NULL REFERENCES seasons(id),
  proposer_id integer NOT NULL REFERENCES users(id),
  target_id   integer NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('award','deduct')),
  amount      integer NOT NULL CHECK (amount BETWEEN 1 AND 100000),
  reason      text NOT NULL CHECK (length(trim(reason)) > 0),
  status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','approved','rejected','expired','reversed','cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  resolved_at timestamptz,
  reversed_at timestamptz,
  reversed_by integer REFERENCES users(id),
  reverse_reason text,
  discord_message_id text,
  CHECK (proposer_id <> target_id)
);
CREATE INDEX proposals_open     ON proposals (status) WHERE status = 'open';
CREATE INDEX proposals_standing ON proposals (season_id, target_id, resolved_at)
  WHERE status = 'approved';

-- Primary key on (proposal_id, voter_id) makes double-voting impossible at the DB level.
CREATE TABLE votes (
  proposal_id integer NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  voter_id    integer NOT NULL REFERENCES users(id),
  vote        text NOT NULL CHECK (vote IN ('accept','reject')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, voter_id)
);

-- Frozen snapshot written when a season closes. display_name is copied so past
-- standings survive someone renaming themselves later.
CREATE TABLE season_standings (
  season_id    integer NOT NULL REFERENCES seasons(id),
  user_id      integer NOT NULL REFERENCES users(id),
  display_name text NOT NULL,
  avatar_emoji text NOT NULL DEFAULT '🙂',
  total        integer NOT NULL,
  rank         integer NOT NULL,
  PRIMARY KEY (season_id, user_id)
);

-- Approved proposals ARE the ledger. No stored balances anywhere: every total is a
-- SUM over this view, so all four leaderboards are one query with a different WHERE,
-- and any total can be traced back to the proposal that caused it.
CREATE VIEW ledger AS
  SELECT id, season_id, target_id AS user_id, proposer_id, kind, reason, resolved_at,
         CASE WHEN kind = 'award' THEN amount ELSE -amount END AS delta
  FROM proposals
  WHERE status = 'approved';

INSERT INTO seasons (name) VALUES (to_char(now(), 'YYYY'));
