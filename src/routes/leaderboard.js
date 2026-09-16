const router = require('express').Router();
const { query, activeSeason } = require('../db');

// All four leaderboards are the same query with a different lower bound on resolved_at.
// That is the payoff of storing no balances: one query, four views, nothing to recompute.
// Values come from this fixed map and are never taken from user input, so interpolating
// the unit into the SQL is safe.
const UNITS = { week: 'week', month: 'month', year: 'year', all: null };

router.get('/', async (req, res, next) => {
  try {
    const name = String(req.query.window || 'week');
    if (!(name in UNITS))
      return res.status(400).json({ error: 'window must be week, month, year or all.' });

    const season = await activeSeason();
    const tz = process.env.APP_TZ || 'Europe/London';
    const unit = UNITS[name];

    // All-time has no date bound, so it must not bind the timezone parameter either.
    const clause = unit
      ? `l.resolved_at >= date_trunc('${unit}', now() AT TIME ZONE $2) AT TIME ZONE $2`
      : 'true';
    const params = unit ? [season.id, tz] : [season.id];

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

    res.json({ window: name, season: season.name, timezone: tz, standings: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
