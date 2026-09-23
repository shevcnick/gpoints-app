const router = require('express').Router();
const { getStandings } = require('../standings');

// All four leaderboards are the same query with a different lower bound on resolved_at.
// That is the payoff of storing no balances: one query, four views, nothing to recompute.
// The query itself lives in src/standings.js, shared with the /leaderboard command.
router.get('/', async (req, res, next) => {
  try {
    const data = await getStandings(String(req.query.window || 'week'));
    if (!data)
      return res.status(400).json({ error: 'window must be week, month, year or all.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
