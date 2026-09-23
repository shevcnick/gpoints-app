const router = require('express').Router();
const { query, activeSeason } = require('../db');
const P = require('../periods');

// Hall of Fame: G of the Week, G of the Month, G of the Year.
//
// None of this is stored. Every winner is computed from the ledger on demand by bucketing
// approved proposals into periods, so there is no scheduled job that can miss a rollover
// and no snapshot that can drift out of step with the points it claims to summarise.

// Winner per bucket. DISTINCT ON takes the top row of each group after ORDER BY, which
// is how ties break deterministically on name rather than arbitrarily.
const WINNERS_SQL = (bucketExpr) => `
  WITH totals AS (
    SELECT ${bucketExpr} AS bucket,
           l.user_id,
           SUM(l.delta)::bigint AS total
    FROM ledger l
    WHERE l.season_id = $2
    GROUP BY bucket, l.user_id
  )
  SELECT DISTINCT ON (t.bucket)
         t.bucket, t.total, u.display_name, u.avatar_emoji
  FROM totals t
  JOIN users u ON u.id = t.user_id
  WHERE t.total > 0
  ORDER BY t.bucket DESC, t.total DESC, u.display_name ASC`;

router.get('/', async (req, res, next) => {
  try {
    const season = await activeSeason();
    const tz = P.tz();
    const now = new Date();

    const current = P.describeNow(season.started_at, now);
    const currentWeekStart = current.week.startsAt;
    const currentMonthStart = current.month.startsAt;
    const currentYearStart = current.year.startsAt;

    const [weeks, months, years] = await Promise.all([
      query(WINNERS_SQL(P.weekStartSQL('l.resolved_at', '$1')), [tz, season.id]),
      query(WINNERS_SQL(P.monthStartSQL('l.resolved_at', '$1')), [tz, season.id]),
      query(WINNERS_SQL(P.yearStartSQL('l.resolved_at', '$1')), [tz, season.id]),
    ]);

    // A period still running has no winner yet — the leaderboard already shows who is
    // ahead, and calling it a win before it ends would be wrong.
    const finished = (rows, currentStart) =>
      rows.filter((r) => new Date(r.bucket) < new Date(currentStart));

    const seasonStart = season.started_at;

    res.json({
      timezone: tz,
      current,
      weeks: finished(weeks.rows, currentWeekStart).map((r) => ({
        label: 'Week ' + P.weekNumber(new Date(r.bucket), seasonStart, tz),
        startsAt: r.bucket,
        display_name: r.display_name,
        avatar_emoji: r.avatar_emoji,
        total: r.total,
      })),
      months: finished(months.rows, currentMonthStart).map((r) => ({
        label: P.monthName(new Date(r.bucket), tz),
        startsAt: r.bucket,
        display_name: r.display_name,
        avatar_emoji: r.avatar_emoji,
        total: r.total,
      })),
      years: finished(years.rows, currentYearStart).map((r) => ({
        label: String(P.parts(new Date(r.bucket), tz).year),
        startsAt: r.bucket,
        display_name: r.display_name,
        avatar_emoji: r.avatar_emoji,
        total: r.total,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Where the app is in time right now: which week number, which month, and when each
// rolls over. The countdown on the leaderboard runs off endsAt.
router.get('/current', async (req, res, next) => {
  try {
    const season = await activeSeason();
    res.json({ season: season.name, ...P.describeNow(season.started_at) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
