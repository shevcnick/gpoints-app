const router = require('express').Router();
const { query, tx, activeSeason } = require('../db');
const discord = require('../discord');

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

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// Admin edit of someone else's identity. Display name is cosmetic; username is what they
// log in with, so changing it locks them out of their old one — hence both are logged
// back in the response for the admin to see what actually changed.
router.patch('/users/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad user id.' });

    const { rows: existing } = await query(
      'SELECT id, username, display_name FROM users WHERE id = $1', [id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'No such user.' });

    const updates = [];
    const values = [];

    if (req.body?.displayName !== undefined) {
      const name = String(req.body.displayName).trim();
      if (name.length < 1 || name.length > 30)
        return res.status(400).json({ error: 'Display name must be 1-30 characters.' });
      values.push(name);
      updates.push(`display_name = $${values.length}`);
    }

    if (req.body?.username !== undefined) {
      const uname = String(req.body.username).trim().toLowerCase();
      if (!USERNAME_RE.test(uname))
        return res.status(400).json({
          error: 'Username must be 3-20 characters: lowercase letters, numbers or underscores.',
        });
      const { rows: clash } = await query(
        'SELECT id FROM users WHERE username = $1 AND id <> $2', [uname, id]
      );
      if (clash[0]) return res.status(409).json({ error: 'That username is taken.' });
      values.push(uname);
      updates.push(`username = $${values.length}`);
    }

    if (req.body?.avatarEmoji !== undefined) {
      const emoji = String(req.body.avatarEmoji).trim();
      if ([...emoji].length < 1 || [...emoji].length > 3)
        return res.status(400).json({ error: 'Avatar must be 1-3 characters.' });
      values.push(emoji);
      updates.push(`avatar_emoji = $${values.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to change.' });

    values.push(id);
    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}
       RETURNING id, username, display_name, avatar_emoji, is_admin`,
      values
    );
    res.json({ user: rows[0], was: existing[0] });
  } catch (err) {
    next(err);
  }
});

// Undo an approved proposal. The row is marked 'reversed' rather than deleted: the ledger
// view only counts 'approved', so the points come straight off, but the history of what
// happened and who undid it survives.
router.post('/proposals/:id/reverse', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad proposal id.' });

    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Say why you are reversing it.' });
    if (reason.length > 280)
      return res.status(400).json({ error: 'Keep the reason under 280 characters.' });

    const result = await tx(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [id]
      );
      const p = rows[0];
      if (!p) return { code: 404, body: { error: 'No such proposal.' } };
      if (p.status === 'reversed')
        return { code: 409, body: { error: 'That one is already reversed.' } };
      if (p.status !== 'approved')
        return {
          code: 409,
          body: { error: `Only approved proposals can be reversed — that one is ${p.status}.` },
        };

      await client.query(
        `UPDATE proposals
         SET status = 'reversed', reversed_at = now(), reversed_by = $1, reverse_reason = $2
         WHERE id = $3`,
        [req.user.id, reason, id]
      );

      const delta = p.kind === 'award' ? -p.amount : p.amount;
      return { code: 200, body: { id, undone: delta, target_id: p.target_id }, reversed: p };
    });

    // Before the response: on serverless nothing runs after res.json().
    if (result.reversed) {
      const p = result.reversed;
      const { rows } = await query('SELECT display_name FROM users WHERE id = $1',
        [p.target_id]);
      await discord.proposalReversed({
        kind: p.kind, amount: p.amount, reason: p.reason,
        targetName: rows[0]?.display_name || 'someone',
        adminName: req.user.display_name, reverseReason: reason,
      });
    }

    res.status(result.code).json(result.body);
  } catch (err) {
    next(err);
  }
});

// Approved proposals, newest first, so the admin can pick one to reverse.
router.get('/ledger', async (req, res, next) => {
  try {
    const season = await activeSeason();
    const { rows } = await query(
      `SELECT p.id, p.kind, p.amount, p.reason, p.status, p.resolved_at,
              p.reverse_reason, p.reversed_at,
              pr.display_name AS proposer_name,
              tg.display_name AS target_name, tg.avatar_emoji AS target_emoji,
              rv.display_name AS reversed_by_name
       FROM proposals p
       JOIN users pr ON pr.id = p.proposer_id
       JOIN users tg ON tg.id = p.target_id
       LEFT JOIN users rv ON rv.id = p.reversed_by
       WHERE p.season_id = $1 AND p.status IN ('approved', 'reversed')
       ORDER BY p.resolved_at DESC
       LIMIT 100`,
      [season.id]
    );
    res.json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

// Everything still open, so junk proposals can be cleared out of the voting list.
router.get('/open', async (req, res, next) => {
  try {
    const season = await activeSeason();
    const { rows } = await query(
      `SELECT p.id, p.kind, p.amount, p.reason, p.created_at, p.expires_at,
              pr.display_name AS proposer_name,
              tg.display_name AS target_name, tg.avatar_emoji AS target_emoji,
              (SELECT count(*)::int FROM votes v
                WHERE v.proposal_id = p.id AND v.vote = 'accept') AS accepts
       FROM proposals p
       JOIN users pr ON pr.id = p.proposer_id
       JOIN users tg ON tg.id = p.target_id
       WHERE p.season_id = $1 AND p.status = 'open'
       ORDER BY p.created_at ASC`,
      [season.id]
    );
    res.json({ proposals: rows });
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
