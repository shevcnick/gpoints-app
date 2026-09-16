const router = require('express').Router();
const { query } = require('../db');

// Hall of Fame: frozen standings from every closed season.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.name, s.started_at, s.closed_at,
              json_agg(json_build_object(
                'rank', ss.rank, 'display_name', ss.display_name,
                'avatar_emoji', ss.avatar_emoji, 'total', ss.total
              ) ORDER BY ss.rank) AS standings
       FROM seasons s
       JOIN season_standings ss ON ss.season_id = s.id
       WHERE s.closed_at IS NOT NULL
       GROUP BY s.id, s.name, s.started_at, s.closed_at
       ORDER BY s.id DESC`
    );
    res.json({ seasons: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
