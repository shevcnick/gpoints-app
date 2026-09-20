const router = require('express').Router();
const { query, activeSeason } = require('../db');
const { hashPassword, verifyPassword, setSession } = require('../auth');
const P = require('../periods');

// The account screen: profile, your own totals, and your recent activity.
router.get('/', async (req, res, next) => {
  try {
    const season = await activeSeason();
    const tz = P.tz();

    const { rows: totals } = await query(
      `SELECT COALESCE(SUM(delta), 0)::int AS all_time,
              COALESCE(SUM(delta) FILTER (
                WHERE resolved_at >= date_trunc('year', now() AT TIME ZONE $3) AT TIME ZONE $3
              ), 0)::int AS year,
              COALESCE(SUM(delta) FILTER (
                WHERE resolved_at >= date_trunc('month', now() AT TIME ZONE $3) AT TIME ZONE $3
              ), 0)::int AS month,
              COALESCE(SUM(delta) FILTER (
                WHERE resolved_at >= date_trunc('week', now() AT TIME ZONE $3) AT TIME ZONE $3
              ), 0)::int AS week,
              count(*) FILTER (WHERE kind = 'award')::int  AS awards,
              count(*) FILTER (WHERE kind = 'deduct')::int AS deductions
       FROM ledger WHERE user_id = $1 AND season_id = $2`,
      [req.user.id, season.id, tz]
    );

    const { rows: activity } = await query(
      `SELECT p.id, p.kind, p.amount, p.reason, p.status, p.resolved_at, p.created_at,
              pr.display_name AS proposer_name, tg.display_name AS target_name,
              (p.proposer_id = $1) AS i_proposed, (p.target_id = $1) AS about_me
       FROM proposals p
       JOIN users pr ON pr.id = p.proposer_id
       JOIN users tg ON tg.id = p.target_id
       WHERE p.proposer_id = $1 OR p.target_id = $1
       ORDER BY p.created_at DESC LIMIT 25`,
      [req.user.id]
    );

    const { rows: linked } = await query(
      'SELECT discord_id FROM users WHERE id = $1', [req.user.id]
    );

    const { rows: voteCount } = await query(
      'SELECT count(*)::int AS votes_cast FROM votes WHERE voter_id = $1',
      [req.user.id]
    );

    res.json({
      user: req.user,
      discordLinked: Boolean(linked[0]?.discord_id),
      season: season.name,
      totals: totals[0],
      votesCast: voteCount[0].votes_cast,
      activity,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const name = String(req.body?.displayName ?? '').trim();
    if (name.length < 1 || name.length > 30)
      return res.status(400).json({ error: 'Display name must be 1-30 characters.' });

    // Emoji are multi-codepoint; [...str] counts characters rather than UTF-16 units.
    const emoji = String(req.body?.avatarEmoji ?? '🙂').trim();
    if ([...emoji].length < 1 || [...emoji].length > 3)
      return res.status(400).json({ error: 'Avatar must be 1-3 characters.' });

    const { rows } = await query(
      `UPDATE users SET display_name = $1, avatar_emoji = $2 WHERE id = $3
       RETURNING id, username, display_name, avatar_emoji, is_admin`,
      [name, emoji, req.user.id]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/password', async (req, res, next) => {
  try {
    const current = String(req.body?.currentPassword || '');
    const next_ = String(req.body?.newPassword || '');
    if (next_.length < 4)
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(current, rows[0].password_hash)))
      return res.status(403).json({ error: 'Current password is wrong.' });

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(next_), req.user.id,
    ]);
    setSession(res, req.user.id); // refresh the cookie so the session stays valid
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Claim the code Discord gave you, linking that Discord account to this one. Votes cast
// from Discord are attributed through this link, so it has to be the user proving they
// hold the Discord account — not an admin guessing.
router.post('/link-discord', async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter the code Discord gave you.' });

    const { rows } = await query(
      `SELECT discord_id FROM discord_link_codes
       WHERE code = $1 AND expires_at > now()`,
      [code]
    );
    if (!rows[0])
      return res.status(404).json({ error: 'That code is wrong or has expired. Click a vote button in Discord for a new one.' });

    const discordId = rows[0].discord_id;

    const { rows: taken } = await query(
      'SELECT id, display_name FROM users WHERE discord_id = $1 AND id <> $2',
      [discordId, req.user.id]
    );
    if (taken[0])
      return res.status(409).json({
        error: `That Discord account is already linked to ${taken[0].display_name}.`,
      });

    await query('UPDATE users SET discord_id = $1 WHERE id = $2', [discordId, req.user.id]);
    await query('DELETE FROM discord_link_codes WHERE discord_id = $1', [discordId]);

    res.json({ linked: true });
  } catch (err) {
    next(err);
  }
});

router.post('/unlink-discord', async (req, res, next) => {
  try {
    await query('UPDATE users SET discord_id = NULL WHERE id = $1', [req.user.id]);
    res.json({ linked: false });
  } catch (err) {
    next(err);
  }
});

// Everyone except you — used to populate the "who is receiving" dropdown.
router.get('/others', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, display_name, avatar_emoji FROM users WHERE id <> $1 ORDER BY display_name`,
      [req.user.id]
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
