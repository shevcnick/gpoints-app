const router = require('express').Router();
const { query, activeSeason } = require('../db');
const P = require('../periods');

// All four leaderboards are the same query with a different lower bound on resolved_at.
// That is the payoff of storing no balances: one query, four views, nothing to recompute.
router.get('/', async (req, res, next) => {
  try {
    const name = String(req.query.window || 'week');
    const clause = P.windowClause(name, '$2');
    if (!clause)
      return res.status(400).json({ error: 'window must be week, month, year or all.' });

    const season = await activeSeason();
    const tz = P.tz();

    // "All time" has no date bound, so its clause never mentions $2 — and binding a
    // parameter the SQL does not use is an error, not a no-op.
    const params = clause.includes('$2') ? [season.id, tz] : [season.id];

    // LEFT JOIN so members with nothing yet still appear, on zero.
    const { rows } = await query(
      `SELECT u.id, u.display_name, u.avatar_emoji,
              COALESCE(SUM(l.delta), 0)::int AS points,
              count(l.id)::int AS changes
       FROM users u
       LEFT JOIN ledger l
         ON l.user_id = u.id AND l.season_id = $1 AND ${clause}
       GROUP BY u.id, u.display_name, u.avatar_emoji
       ORDER BY points DESC, u.display_name ASC`,
      params
    );

    res.json({
      window: name,
      season: season.name,
      timezone: tz,
      period: P.describeNow(season.started_at),
      standings: rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
