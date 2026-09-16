const router = require('express').Router();
const { query, tx, activeSeason } = require('../db');

const STANDINGS_SQL = `
  SELECT u.id AS user_id, u.display_name, u.avatar_emoji,
         COALESCE(SUM(l.delta), 0)::int AS total
  FROM users u
  LEFT JOIN ledger l ON l.user_id = u.id AND l.season_id = $1
  GROUP BY u.id, u.display_name, u.avatar_emoji
  ORDER BY total DESC, u.display_name ASC`;

// Full dump of the active season. Download this before closing; the close itself also
// writes a snapshot to season_standings, so there are two independent copies.
router.get('/export', async (req, res, next) => {
  try {
    const season = await activeSeason();
    const [standings, proposals, votes, users] = await Promise.all([
      query(STANDINGS_SQL, [season.id]),
      query(
        `SELECT p.*, pr.display_name AS proposer_name, tg.display_name AS target_name
         FROM proposals p
         JOIN users pr ON pr.id = p.proposer_id
         JOIN users tg ON tg.id = p.target_id
         WHERE p.season_id = $1 ORDER BY p.id`,
        [season.id]
      ),
      query(
        `SELECT v.*, u.display_name AS voter_name FROM votes v
         JOIN users u ON u.id = v.voter_id
         JOIN proposals p ON p.id = v.proposal_id
         WHERE p.season_id = $1 ORDER BY v.proposal_id, v.created_at`,
        [season.id]
      ),
      query('SELECT id, username, display_name, avatar_emoji, created_at FROM users ORDER BY id'),
    ]);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gpoints-${season.name}-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.send(JSON.stringify({
      exportedAt: new Date().toISOString(),
      season,
      standings: standings.rows,
      users: users.rows,
      proposals: proposals.rows,
      votes: votes.rows,
    }, null, 2));
  } catch (err) {
    next(err);
  }
});

// The Jan 1 wipe. Nothing is deleted: proposals keep their season_id and stay queryable
// forever. Because every leaderboard filters to the ACTIVE season, closing one genuinely
// puts everybody back to zero.
router.post('/close-season', async (req, res, next) => {
  try {
    const confirmed = String(req.body?.confirm || '');
    const result = await tx(async (client) => {
      const { rows: seasonRows } = await client.query(
        `SELECT * FROM seasons WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`
      );
      const season = seasonRows[0];
      if (!season) return { code: 409, body: { error: 'No active season.' } };
      if (confirmed !== season.name)
        return {
          code: 400,
          body: { error: `Type the season name "${season.name}" to confirm.` },
        };

      const { rows: standings } = await client.query(STANDINGS_SQL, [season.id]);

      for (let i = 0; i < standings.length; i++) {
        const s = standings[i];
        await client.query(
          `INSERT INTO season_standings
             (season_id, user_id, display_name, avatar_emoji, total, rank)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [season.id, s.user_id, s.display_name, s.avatar_emoji, s.total, i + 1]
        );
      }

      // Open proposals die with the season rather than carrying votes across the boundary.
      const { rowCount: expired } = await client.query(
        `UPDATE proposals SET status = 'expired', resolved_at = now()
         WHERE season_id = $1 AND status = 'open'`,
        [season.id]
      );

      await client.query('UPDATE seasons SET closed_at = now() WHERE id = $1', [season.id]);
      const { rows: created } = await client.query(
        `INSERT INTO seasons (name) VALUES ($1) RETURNING *`,
        [String(Number(season.name) + 1 || new Date().getFullYear())]
      );

      return {
        code: 200,
        body: {
          closed: season.name,
          newSeason: created[0].name,
          archived: standings.length,
          expiredProposals: expired,
          champion: standings[0] || null,
        },
      };
    });
    res.status(result.code).json(result.body);
  } catch (err) {
    next(err);
  }
});

router.get('/members', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_emoji, u.is_admin, u.created_at,
              (SELECT count(*)::int FROM votes v WHERE v.voter_id = u.id) AS votes_cast,
              (SELECT count(*)::int FROM proposals p WHERE p.proposer_id = u.id) AS proposed
       FROM users u ORDER BY u.id`
    );
    res.json({ members: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
