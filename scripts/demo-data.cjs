// Fills the seeded database with believable activity so the leaderboard and feed have
// something in them. Dev only. Run after `npm run db:reset`.
require('dotenv').config();
const { query, activeSeason } = require('../src/db');

// [target, proposer, kind, amount, reason, daysAgo]
const APPROVED = [
  ['Bob',   'Alice', 'award',  50,   'carried the entire group project',        1],
  ['Carol', 'Dave',  'award',  25,   'drove everyone home at 3am',              2],
  ['Frank', 'Alice', 'deduct', 30,   'wore the crocs. again.',                  2],
  ['Erin',  'Bob',   'award',  100,  'got us into the sold out gig',            4],
  ['Dave',  'Carol', 'deduct', 15,   'said the film was "mid" then fell asleep', 5],
  ['Bob',   'Erin',  'award',  10,   'brought snacks unprompted',               6],
  ['Alice', 'Frank', 'award',  75,   'fixed my laptop at midnight',            12],
  ['Carol', 'Bob',   'deduct', 40,   'left the group chat on read for 3 days',  20],
  ['Erin',  'Dave',  'award',  60,   'remembered literally everyone birthday',  45],
  ['Frank', 'Carol', 'award',  500,  'the legendary parallel park',             90],
  ['Dave',  'Alice', 'deduct', 100,  'the incident with the barbecue',         120],
];

// [target, proposer, kind, amount, reason, acceptedBy]
const OPEN = [
  ['Alice', 'Bob',   'award',  35,  'talked the bouncer into letting us in', ['Carol']],
  ['Dave',  'Erin',  'deduct', 20,  'ate the last slice without asking',     ['Frank', 'Alice']],
  ['Carol', 'Frank', 'award',  100000, 'the single greatest assist in history', []],
];

(async () => {
  const season = await activeSeason();
  const { rows: users } = await query('SELECT id, display_name FROM users');
  const id = (name) => {
    const u = users.find((x) => x.display_name === name);
    if (!u) throw new Error('No seeded user named ' + name + ' — run npm run db:reset first');
    return u.id;
  };

  for (const [target, proposer, kind, amount, reason, days] of APPROVED) {
    const { rows } = await query(
      `INSERT INTO proposals
         (season_id, proposer_id, target_id, kind, amount, reason, status, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved',
               now() - ($7 || ' days')::interval,
               now() - ($7 || ' days')::interval)
       RETURNING id`,
      [season.id, id(proposer), id(target), kind, amount, reason, String(days)]
    );
    // Three neutral accepts, which is what made it approved in the first place.
    const voters = users
      .filter((u) => u.display_name !== target && u.display_name !== proposer)
      .slice(0, 3);
    for (const v of voters) {
      await query(
        `INSERT INTO votes (proposal_id, voter_id, vote) VALUES ($1, $2, 'accept')`,
        [rows[0].id, v.id]
      );
    }
  }

  for (const [target, proposer, kind, amount, reason, acceptedBy] of OPEN) {
    const { rows } = await query(
      `INSERT INTO proposals (season_id, proposer_id, target_id, kind, amount, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [season.id, id(proposer), id(target), kind, amount, reason]
    );
    for (const name of acceptedBy) {
      await query(
        `INSERT INTO votes (proposal_id, voter_id, vote) VALUES ($1, $2, 'accept')`,
        [rows[0].id, id(name)]
      );
    }
  }

  const { rows: board } = await query(
    `SELECT u.display_name, COALESCE(SUM(l.delta), 0)::int AS pts
     FROM users u LEFT JOIN ledger l ON l.user_id = u.id
     GROUP BY u.display_name ORDER BY pts DESC`
  );
  console.log(APPROVED.length + ' approved, ' + OPEN.length + ' open votes waiting');
  console.log('All-time: ' + board.map((r) => r.display_name + ' ' + r.pts).join(' · '));
  process.exit(0);
})().catch((err) => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
