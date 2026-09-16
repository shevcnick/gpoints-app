const router = require('express').Router();
const { query, tx, activeSeason } = require('../db');

const MAX_AMOUNT = 100000;
const votesRequired = () => Number(process.env.VOTES_REQUIRED) || 3;

// Lazily retires proposals past their deadline, which avoids needing a cron job.
const sweepExpired = () =>
  query(`UPDATE proposals SET status = 'expired', resolved_at = now()
         WHERE status = 'open' AND expires_at < now()`);

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

    const { rows: targetRows } = await query('SELECT id FROM users WHERE id = $1', [target]);
    if (!targetRows[0]) return res.status(400).json({ error: 'That person does not exist.' });

    const season = await activeSeason();
    const { rows } = await query(
      `INSERT INTO proposals (season_id, proposer_id, target_id, kind, amount, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [season.id, req.user.id, target, kind, amt, why]
    );
    res.status(201).json({ id: rows[0].id, votesRequired: votesRequired() });
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

// The one endpoint where a race could mint points twice, so the read, the insert and the
// status flip all happen inside one transaction against a locked proposal row.
router.post('/:id/vote', async (req, res, next) => {
  try {
    const vote = req.body?.vote;
    if (vote !== 'accept' && vote !== 'reject')
      return res.status(400).json({ error: 'Vote must be accept or reject.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad proposal id.' });

    await sweepExpired();
    const needed = votesRequired();

    const result = await tx(async (client) => {
      // FOR UPDATE serializes concurrent voters on this proposal: the second voter
      // blocks here until the first has committed, so both see an accurate tally.
      const { rows } = await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [id]);
      const p = rows[0];
      if (!p) return { code: 404, body: { error: 'That proposal is gone.' } };
      if (p.status !== 'open')
        return { code: 409, body: { error: `Already ${p.status} — voting is closed.` } };
      if (new Date(p.expires_at) < new Date())
        return { code: 409, body: { error: 'That proposal expired.' } };
      if (p.proposer_id === req.user.id)
        return { code: 403, body: { error: "You proposed this, so you can't vote on it." } };
      if (p.target_id === req.user.id)
        return { code: 403, body: { error: "You can't vote on your own points." } };

      const inserted = await client.query(
        `INSERT INTO votes (proposal_id, voter_id, vote) VALUES ($1, $2, $3)
         ON CONFLICT (proposal_id, voter_id) DO NOTHING RETURNING vote`,
        [id, req.user.id, vote]
      );
      if (!inserted.rows[0])
        return { code: 409, body: { error: 'You already voted on this one.' } };

      const { rows: tally } = await client.query(
        `SELECT count(*) FILTER (WHERE vote = 'accept') AS accepts,
                count(*) FILTER (WHERE vote = 'reject') AS rejects
         FROM votes WHERE proposal_id = $1`,
        [id]
      );
      const accepts = Number(tally[0].accepts);
      const rejects = Number(tally[0].rejects);

      let status = 'open';
      if (accepts >= needed) status = 'approved';
      else if (rejects >= needed) status = 'rejected';

      if (status !== 'open') {
        await client.query(
          `UPDATE proposals SET status = $1, resolved_at = now() WHERE id = $2`,
          [status, id]
        );
      }
      return { code: 200, body: { status, accepts, rejects, votesRequired: needed } };
    });

    res.status(result.code).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
