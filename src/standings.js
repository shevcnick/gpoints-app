// The leaderboard query, in one place.
//
// The web page and the /leaderboard command must not disagree about who is winning, so
// neither builds this itself.

const { query, activeSeason } = require('./db');
const P = require('./periods');

/**
 * Standings for one window of the active season, highest first.
 * Members with nothing yet are included on zero.
 */
async function getStandings(windowName = 'week') {
  const clause = P.windowClause(windowName, '$2');
  if (!clause) return null;

  const season = await activeSeason();
  const tz = P.tz();

  // "All time" has no date bound, so its clause never mentions $2 — and binding a
  // parameter the SQL does not use is an error, not a no-op.
  const params = clause.includes('$2') ? [season.id, tz] : [season.id];

  const { rows } = await query(
    `SELECT u.id, u.display_name, u.avatar_emoji,
            COALESCE(SUM(l.delta), 0)::bigint AS points,
            count(l.id)::int AS changes
     FROM users u
     LEFT JOIN ledger l
       ON l.user_id = u.id AND l.season_id = $1 AND ${clause}
     GROUP BY u.id, u.display_name, u.avatar_emoji
     ORDER BY points DESC, u.display_name ASC`,
    params
  );

  return {
    window: windowName,
    season: season.name,
    timezone: tz,
    period: P.describeNow(season.started_at),
    standings: rows,
  };
}

// Equal scores share a rank, so three people on zero are all joint-whatever.
function withRanks(standings) {
  let rank = 0;
  let last = null;
  return standings.map((s, i) => {
    if (s.points !== last) { rank = i + 1; last = s.points; }
    return { ...s, rank };
  });
}

module.exports = { getStandings, withRanks };
