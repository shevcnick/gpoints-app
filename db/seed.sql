-- Local dev only. Six users so the 3-neutral-voter rule can actually be exercised
-- (proposer + target + 3 voters = 5 minimum; 6 gives you a spare).
-- Every password is "test".
INSERT INTO users (username, display_name, avatar_emoji, password_hash, is_admin) VALUES
  ('alice', 'Alice', '🦊', '$2b$10$jGNLrPESZhXfk6gB.jeY5uydOCoen2ZkgNQDwRKPEinU9Pwvfif1q', true),
  ('bob',   'Bob',   '🐻', '$2b$10$jGNLrPESZhXfk6gB.jeY5uydOCoen2ZkgNQDwRKPEinU9Pwvfif1q', false),
  ('carol', 'Carol', '🦉', '$2b$10$jGNLrPESZhXfk6gB.jeY5uydOCoen2ZkgNQDwRKPEinU9Pwvfif1q', false),
  ('dave',  'Dave',  '🐸', '$2b$10$jGNLrPESZhXfk6gB.jeY5uydOCoen2ZkgNQDwRKPEinU9Pwvfif1q', false),
  ('erin',  'Erin',  '🐙', '$2b$10$jGNLrPESZhXfk6gB.jeY5uydOCoen2ZkgNQDwRKPEinU9Pwvfif1q', false),
  ('frank', 'Frank', '🦝', '$2b$10$jGNLrPESZhXfk6gB.jeY5uydOCoen2ZkgNQDwRKPEinU9Pwvfif1q', false)
ON CONFLICT (username) DO NOTHING;
