const router = require('express').Router();
const { query, tx, activeSeason } = require('../db');
const discord = require('../discord');

const STANDINGS_SQL = `
  SELECT u.id AS user_id, u.display_name, u.avatar_emoji,
         COALESCE(SUM(l.delta), 0)::bigint AS total
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

    if (req.body?.isAdmin !== undefined) {
      const makeAdmin = Boolean(req.body.isAdmin);
      // Removing the last admin would lock everyone out of this page for good.
      if (!makeAdmin) {
        if (id === req.user.id)
          return res.status(400).json({ error: 'You cannot remove your own admin rights.' });
        const { rows: admins } = await query(
          'SELECT count(*)::int AS c FROM users WHERE is_admin = true'
        );
        if (admins[0].c <= 1)
          return res.status(409).json({ error: 'That is the only admin left.' });
      }
      values.push(makeAdmin);
      updates.push(`is_admin = $${values.length}`);
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

const MAX_AMOUNT = 1000000000;

// Set someone's season total directly.
//
// There are no stored balances, so this cannot just overwrite a number. It writes the
// difference as an ordinary approved ledger row, flagged as an adjustment — the total
// lands where you asked, the feed says an admin did it and why, and every point still
// traces back to a row.
router.post('/users/:id/adjust', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad user id.' });

    const { rows: target } = await query(
      'SELECT id, display_name FROM users WHERE id = $1', [id]
    );
    if (!target[0]) return res.status(404).json({ error: 'No such user.' });

    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Say why you are changing it.' });
    if (reason.length > 280)
      return res.status(400).json({ error: 'Keep the reason under 280 characters.' });

    const season = await activeSeason();

    const result = await tx(async (client) => {
      // Locking the ledger rows is not possible through a view, so lock the user row:
      // two admins adjusting the same person at once must not both read the same total.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [id]);

      const { rows: current } = await client.query(
        `SELECT COALESCE(SUM(delta), 0)::bigint AS total FROM ledger
         WHERE user_id = $1 AND season_id = $2`,
        [id, season.id]
      );
      const before = current[0].total;

      // Either an exact total to land on, or a straight delta.
      let delta;
      if (req.body?.setTo !== undefined) {
        const setTo = Number(req.body.setTo);
        if (!Number.isInteger(setTo))
          return { code: 400, body: { error: 'New total must be a whole number.' } };
        delta = setTo - before;
      } else {
        delta = Number(req.body?.delta);
        if (!Number.isInteger(delta))
          return { code: 400, body: { error: 'Change must be a whole number.' } };
      }

      if (delta === 0)
        return { code: 400, body: { error: 'That is already their total.' } };

      if (Math.abs(delta) > MAX_AMOUNT)
        return {
          code: 400,
          body: {
            error: `That is a change of ${Math.abs(delta).toLocaleString()}, and a single `
              + `entry is capped at ${MAX_AMOUNT.toLocaleString()}. Do it in steps.`,
          },
        };

      await client.query(
        `INSERT INTO proposals
           (season_id, proposer_id, target_id, kind, amount, reason,
            status, resolved_at, is_adjustment)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', now(), true)`,
        [
          season.id, req.user.id, id,
          delta > 0 ? 'award' : 'deduct', Math.abs(delta), reason,
        ]
      );

      return { code: 200, body: { before, after: before + delta, delta } };
    });

    res.status(result.code).json(result.body);
  } catch (err) {
    next(err);
  }
});

// What deleting this member would actually do. A member is tangled into the ledger in
// three directions — points they received, points they proposed for other people, and
// votes they cast — so this is shown before anything is destroyed.
async function deletionImpact(id) {
  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM proposals WHERE target_id = $1)   AS as_target,
       (SELECT count(*)::int FROM proposals WHERE proposer_id = $1) AS as_proposer,
       (SELECT count(*)::int FROM votes WHERE voter_id = $1)        AS votes_cast,
       (SELECT COALESCE(SUM(delta), 0)::bigint FROM ledger WHERE user_id = $1) AS own_points`,
    [id]
  );

  // Points other people keep only because this member proposed them. Deleting the
  // member deletes those proposals, so those totals move.
  const { rows: affected } = await query(
    `SELECT u.display_name, SUM(l.delta)::bigint AS delta
     FROM ledger l JOIN users u ON u.id = l.user_id
     WHERE l.proposer_id = $1 AND l.user_id <> $1
     GROUP BY u.display_name
     HAVING SUM(l.delta) <> 0
     ORDER BY abs(SUM(l.delta)) DESC`,
    [id]
  );

  return { ...rows[0], affectsOthers: affected };
}

router.get('/users/:id/impact', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad user id.' });
    const { rows } = await query(
      'SELECT id, username, display_name FROM users WHERE id = $1', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No such user.' });
    res.json({ user: rows[0], impact: await deletionImpact(id) });
  } catch (err) {
    next(err);
  }
});

// Permanently remove a member and everything they were involved in.
//
// Deliberately not a soft delete: this exists to clean up duplicate and junk accounts,
// and a hidden account still holding points would be worse than no feature. The username
// must be typed to confirm, and the response reports exactly whose totals moved.
router.delete('/users/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad user id.' });

    if (id === req.user.id)
      return res.status(400).json({ error: 'You cannot delete your own account.' });

    const { rows: target } = await query(
      'SELECT id, username, display_name, is_admin, discord_id FROM users WHERE id = $1',
      [id]
    );
    if (!target[0]) return res.status(404).json({ error: 'No such user.' });

    if (String(req.body?.confirm || '').trim().toLowerCase() !== target[0].username)
      return res.status(400).json({
        error: `Type the username "${target[0].username}" to confirm.`,
      });

    if (target[0].is_admin) {
      const { rows: admins } = await query(
        'SELECT count(*)::int AS c FROM users WHERE is_admin = true'
      );
      if (admins[0].c <= 1)
        return res.status(409).json({ error: 'That is the only admin. Promote someone else first.' });
    }

    const impact = await deletionImpact(id);

    await tx(async (client) => {
      // Votes they cast on other people's proposals. Those proposals keep whatever
      // status they already reached; a settled vote is not re-opened.
      await client.query('DELETE FROM votes WHERE voter_id = $1', [id]);

      // Every proposal they were either side of, and the votes on them.
      await client.query(
        `DELETE FROM votes WHERE proposal_id IN
           (SELECT id FROM proposals WHERE proposer_id = $1 OR target_id = $1)`,
        [id]
      );
      await client.query(
        'DELETE FROM proposals WHERE proposer_id = $1 OR target_id = $1', [id]
      );

      await client.query('DELETE FROM season_standings WHERE user_id = $1', [id]);
      if (target[0].discord_id) {
        await client.query('DELETE FROM discord_link_codes WHERE discord_id = $1',
          [target[0].discord_id]);
      }
      await client.query('DELETE FROM users WHERE id = $1', [id]);
    });

    res.json({ deleted: target[0].display_name, username: target[0].username, impact });
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

// Tells you exactly why Discord posting is failing, without digging through logs.
// Read-only apart from the test message it offers to send.
router.get('/discord-check', async (req, res, next) => {
  try {
    const bot = require('../discordBot');
    const out = {
      botToken: Boolean((process.env.DISCORD_BOT_TOKEN || '').trim()),
      publicKey: Boolean((process.env.DISCORD_PUBLIC_KEY || '').trim()),
      channelId: (process.env.DISCORD_CHANNEL_ID || '').trim() || null,
      appUrl: (process.env.APP_URL || '').trim() || null,
      discordVoting: bot.configured(),
      appVoting: bot.appVotingEnabled(),
    };

    if (!out.discordVoting) {
      out.verdict = 'Discord voting is not fully configured yet.';
      return res.json(out);
    }

    // Who is the bot, and is the channel reachable?
    const me = await bot.api('/users/@me');
    out.botUser = me.ok ? `${me.body.username} (${me.body.id})` : null;
    if (!me.ok) {
      out.verdict = bot.explainFailure(me);
      return res.json(out);
    }

    const channel = await bot.api('/channels/' + out.channelId);
    if (!channel.ok) {
      out.channel = null;
      out.verdict = bot.explainFailure(channel);
      return res.json(out);
    }

    out.channel = {
      name: channel.body.name,
      // 0 is a normal text channel; 4 is a category, which cannot hold messages.
      type: channel.body.type,
      isTextChannel: channel.body.type === 0 || channel.body.type === 5,
      guild: channel.body.guild_id,
    };

    if (!out.channel.isTextChannel) {
      out.verdict = `DISCORD_CHANNEL_ID points at "${channel.body.name}", which is not a `
        + 'text channel (type ' + channel.body.type + '). Use a normal text channel.';
      return res.json(out);
    }

    if (req.query.send === '1') {
      const sent = await bot.api('/channels/' + out.channelId + '/messages', {
        method: 'POST',
        body: JSON.stringify({
          content: 'G Points test message — posting works. You can ignore this.',
          allowed_mentions: { parse: [] },
        }),
      });
      out.testMessage = sent.ok ? 'sent' : bot.explainFailure(sent);
      out.verdict = sent.ok
        ? 'Everything works — the bot posted to the channel successfully.'
        : 'The channel exists but the bot cannot post in it. ' + out.testMessage;
      return res.json(out);
    }

    out.verdict = 'Config looks right. Add ?send=1 to this URL to post a real test '
      + 'message and prove the bot can write there.';
    res.json(out);
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
    const season = await activeSeason();
    const { rows } = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_emoji, u.is_admin, u.created_at,
              (u.discord_id IS NOT NULL) AS discord_linked,
              (SELECT count(*)::int FROM votes v WHERE v.voter_id = u.id) AS votes_cast,
              (SELECT count(*)::int FROM proposals p WHERE p.proposer_id = u.id) AS proposed,
              (SELECT COALESCE(SUM(l.delta), 0)::bigint FROM ledger l
                WHERE l.user_id = u.id AND l.season_id = $1) AS points
       FROM users u ORDER BY u.id`,
      [season.id]
    );
    res.json({ members: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
