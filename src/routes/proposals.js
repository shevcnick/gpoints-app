const router = require('express').Router();
const { query, tx, activeSeason } = require('../db');
const discord = require('../discord');
const bot = require('../discordBot');
const { castVote, votesRequired, sweepExpired, proposalForDisplay } = require('../voting');

const MAX_AMOUNT = 100000;


const PROPOSAL_FIELDS = `
  p.id, p.kind, p.amount, p.reason, p.status, p.created_at, p.expires_at, p.resolved_at,
  p.proposer_id, p.target_id,
  pr.display_name AS proposer_name, pr.avatar_emoji AS proposer_emoji,
  tg.display_name AS target_name,   tg.avatar_emoji AS target_emoji,
  (SELECT count(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote = 'accept') AS accepts,
  (SELECT count(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote = 'reject') AS rejects,
  (SELECT v.vote FROM votes v WHERE v.proposal_id = p.id AND v.voter_id = $2) AS my_vote`;

router.post('/', async (req, res, next) => {
  try {
    const { targetId, kind, amount, reason } = req.body || {};

    if (kind !== 'award' && kind !== 'deduct')
      return res.status(400).json({ error: 'Pick award or deduct.' });

    const target = Number(targetId);
    if (!Number.isInteger(target))
      return res.status(400).json({ error: 'Pick who is receiving this.' });
    if (target === req.user.id)
      return res.status(400).json({ error: "You can't propose points for yourself." });

    // Number() on "abc" gives NaN and on "5.5" gives a non-integer; both rejected here,
    // and the DB CHECK constraint backs the range up if anything slips through.
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 1 || amt > MAX_AMOUNT)
      return res.status(400).json({
        error: `How many must be a whole number between 1 and ${MAX_AMOUNT.toLocaleString()}.`,
      });

    const why = String(reason || '').trim();
    if (!why) return res.status(400).json({ error: 'You have to say why.' });
    if (why.length > 280) return res.status(400).json({ error: 'Keep the reason under 280 characters.' });

    const { rows: targetRows } = await query(
      'SELECT id, display_name FROM users WHERE id = $1', [target]
    );
    if (!targetRows[0]) return res.status(400).json({ error: 'That person does not exist.' });

    const season = await activeSeason();
    const { rows } = await query(
      `INSERT INTO proposals (season_id, proposer_id, target_id, kind, amount, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [season.id, req.user.id, target, kind, amt, why]
    );
    const id = rows[0].id;

    // Before the response: on serverless the function stops executing once a response is
    // sent, so anything fired afterwards is killed.
    //
    // With the bot configured, the proposal is posted as a message carrying the vote
    // buttons, and its id is stored so the tally can be edited in place later. Without
    // it, fall back to the plain one-way webhook.
    if (bot.configured()) {
      const posted = await bot.postProposal({
        id, kind, amount: amt, reason: why,
        proposerName: req.user.display_name,
        targetName: targetRows[0].display_name,
        votesRequired: votesRequired(),
      });
      if (posted.ok && posted.body?.id) {
        await query('UPDATE proposals SET discord_message_id = $1 WHERE id = $2',
          [posted.body.id, id]);
      } else if (!bot.appVotingEnabled()) {
        // Voting only happens in Discord, so a proposal that never reached Discord can
        // never be voted on. Undo it and say so, rather than stranding it.
        await query('DELETE FROM proposals WHERE id = $1', [id]);
        return res.status(502).json({
          error: 'Could not post this to Discord, so it was not created. '
            + 'The bot may be missing permission to post in the G Points channel.',
        });
      }
    } else {
      await discord.proposalOpened({
        kind, amount: amt, reason: why,
        proposerName: req.user.display_name,
        targetName: targetRows[0].display_name,
        votesRequired: votesRequired(),
      });
    }

    res.status(201).json({
      id,
      votesRequired: votesRequired(),
      voteIn: bot.appVotingEnabled() ? 'app' : 'discord',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/proposals?status=open|resolved
router.get('/', async (req, res, next) => {
  try {
    await sweepExpired();
    const season = await activeSeason();
    const resolved = req.query.status === 'resolved';

    const { rows } = await query(
      `SELECT ${PROPOSAL_FIELDS}
       FROM proposals p
       JOIN users pr ON pr.id = p.proposer_id
       JOIN users tg ON tg.id = p.target_id
       WHERE p.season_id = $1
         AND p.status ${resolved ? "<> 'open'" : "= 'open'"}
       ORDER BY ${resolved ? 'p.resolved_at DESC' : 'p.created_at ASC'}
       LIMIT 200`,
      [season.id, req.user.id]
    );

    res.json({
      votesRequired: votesRequired(),
      // The page hides its vote buttons when voting has moved to Discord.
      appVoting: bot.appVotingEnabled(),
      proposals: rows.map((r) => ({
        ...r,
        accepts: Number(r.accepts),
        rejects: Number(r.rejects),
        // Why the vote buttons are hidden, so the UI can explain rather than just disable.
        blocked:
          r.proposer_id === req.user.id ? 'you proposed this'
          : r.target_id === req.user.id ? 'this is about you'
          : r.my_vote ? 'you already voted'
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Voting from the app. The rules live in src/voting.js so the Discord path cannot drift
// away from them; this handler only decides whether app voting is open at all.
router.post('/:id/vote', async (req, res, next) => {
  try {
    if (!bot.appVotingEnabled()) {
      return res.status(403).json({
        error: 'Voting happens in Discord now. Open the channel and use the buttons.',
      });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad proposal id.' });

    const result = await castVote({ proposalId: id, voterId: req.user.id, vote: req.body?.vote });

    // Keep the Discord message in step with a vote cast in the app, and announce the
    // outcome. Before the response: nothing runs after res.json() on serverless.
    await syncDiscord(id, result);

    res.status(result.code).json(result.body);
  } catch (err) {
    next(err);
  }
});

// Mirrors a vote back to Discord: redraw the tally, and announce if it settled.
async function syncDiscord(proposalId, result) {
  if (result.code !== 200) return;
  try {
    const fresh = await proposalForDisplay(proposalId);
    if (fresh?.discord_message_id && bot.configured()) {
      await bot.editProposal(fresh.discord_message_id, { ...fresh, id: proposalId });
    }
    if (result.resolved) {
      const p = result.resolved;
      const { rows } = await query(
        'SELECT display_name FROM users WHERE id = $1', [p.target_id]);
      await discord.proposalResolved({
        kind: p.kind, amount: p.amount, reason: p.reason,
        targetName: rows[0]?.display_name || 'someone',
        status: p.status, accepts: p.accepts, rejects: p.rejects,
      });
    }
  } catch (err) {
    console.error('Could not sync Discord: ' + err.message);
  }
}

// Two different needs behind one verb:
//
//   the proposer, on their own OPEN proposal  -> cancel. Status becomes 'cancelled',
//       so it leaves the voting list but the record of asking survives.
//   an admin, on anything                     -> permanent delete, votes and all.
//
// Reversing and deleting are not the same thing. Reversing an approved proposal takes
// the points off and says publicly why; deleting it erases that it ever happened. The
// response says which occurred so the UI can be honest about it.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad proposal id.' });

    const result = await tx(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [id]
      );
      const p = rows[0];
      if (!p) return { code: 404, body: { error: 'No such proposal.' } };

      if (req.user.is_admin) {
        await client.query('DELETE FROM votes WHERE proposal_id = $1', [id]);
        await client.query('DELETE FROM proposals WHERE id = $1', [id]);
        return {
          code: 200,
          body: {
            deleted: true,
            wasStatus: p.status,
            // Deleting an approved proposal silently moves someone's total, so say so.
            pointsChanged: p.status === 'approved'
              ? (p.kind === 'award' ? -p.amount : p.amount)
              : 0,
          },
        };
      }

      if (p.proposer_id !== req.user.id)
        return { code: 403, body: { error: 'You can only cancel your own proposals.' } };
      if (p.status !== 'open')
        return {
          code: 409,
          body: { error: `Too late — that one is already ${p.status}.` },
        };

      await client.query(
        `UPDATE proposals SET status = 'cancelled', resolved_at = now() WHERE id = $1`,
        [id]
      );
      return { code: 200, body: { cancelled: true } };
    });

    res.status(result.code).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
