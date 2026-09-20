// The voting rules, in one place.
//
// Votes arrive from two directions now — the app and Discord button clicks — and the
// rules must not drift apart between them. Both call castVote; neither reimplements
// "can this person vote on this".

const { query, tx } = require('./db');

const votesRequired = () => Number(process.env.VOTES_REQUIRED) || 3;

// Lazily retires proposals past their deadline, which avoids needing a cron job.
const sweepExpired = () =>
  query(`UPDATE proposals SET status = 'expired', resolved_at = now()
         WHERE status = 'open' AND expires_at < now()`);

/**
 * Record one vote and settle the proposal if this was the deciding one.
 *
 * Everything happens inside a transaction against a locked proposal row: two people
 * clicking the third Accept at the same moment must not both see themselves as decisive
 * and apply the points twice.
 *
 * @returns {{code:number, body:object, resolved:object|null, proposal:object|null}}
 */
async function castVote({ proposalId, voterId, vote }) {
  if (vote !== 'accept' && vote !== 'reject') {
    return { code: 400, body: { error: 'Vote must be accept or reject.' }, resolved: null };
  }

  await sweepExpired();
  const needed = votesRequired();

  return tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]
    );
    const p = rows[0];
    if (!p) return { code: 404, body: { error: 'That proposal is gone.' }, resolved: null };
    if (p.status !== 'open')
      return {
        code: 409,
        body: { error: `Already ${p.status} — voting is closed.` },
        resolved: null, proposal: p,
      };
    if (new Date(p.expires_at) < new Date())
      return { code: 409, body: { error: 'That proposal expired.' }, resolved: null, proposal: p };
    if (p.proposer_id === voterId)
      return {
        code: 403,
        body: { error: "You proposed this, so you can't vote on it." },
        resolved: null, proposal: p,
      };
    if (p.target_id === voterId)
      return {
        code: 403,
        body: { error: "You can't vote on your own points." },
        resolved: null, proposal: p,
      };

    const inserted = await client.query(
      `INSERT INTO votes (proposal_id, voter_id, vote) VALUES ($1, $2, $3)
       ON CONFLICT (proposal_id, voter_id) DO NOTHING RETURNING vote`,
      [proposalId, voterId, vote]
    );
    if (!inserted.rows[0])
      return {
        code: 409,
        body: { error: 'You already voted on this one.' },
        resolved: null, proposal: p,
      };

    const { rows: tally } = await client.query(
      `SELECT count(*) FILTER (WHERE vote = 'accept') AS accepts,
              count(*) FILTER (WHERE vote = 'reject') AS rejects
       FROM votes WHERE proposal_id = $1`,
      [proposalId]
    );
    const accepts = Number(tally[0].accepts);
    const rejects = Number(tally[0].rejects);

    let status = 'open';
    if (accepts >= needed) status = 'approved';
    else if (rejects >= needed) status = 'rejected';

    if (status !== 'open') {
      await client.query(
        `UPDATE proposals SET status = $1, resolved_at = now() WHERE id = $2`,
        [status, proposalId]
      );
    }

    return {
      code: 200,
      body: { status, accepts, rejects, votesRequired: needed },
      // Carried out of the transaction so announcements happen after commit — never
      // announce points that might still roll back.
      resolved: status !== 'open' ? { ...p, status, accepts, rejects } : null,
      proposal: { ...p, status, accepts, rejects },
    };
  });
}

// Everything needed to redraw a proposal's Discord message.
async function proposalForDisplay(proposalId) {
  const { rows } = await query(
    `SELECT p.id, p.kind, p.amount, p.reason, p.status, p.discord_message_id,
            pr.display_name AS proposer_name,
            tg.display_name AS target_name,
            (SELECT count(*)::int FROM votes v
              WHERE v.proposal_id = p.id AND v.vote = 'accept') AS accepts,
            (SELECT count(*)::int FROM votes v
              WHERE v.proposal_id = p.id AND v.vote = 'reject') AS rejects,
            (SELECT coalesce(array_agg(u.display_name ORDER BY v.created_at), '{}')
               FROM votes v JOIN users u ON u.id = v.voter_id
              WHERE v.proposal_id = p.id) AS voter_names
     FROM proposals p
     JOIN users pr ON pr.id = p.proposer_id
     JOIN users tg ON tg.id = p.target_id
     WHERE p.id = $1`,
    [proposalId]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    proposerName: rows[0].proposer_name,
    targetName: rows[0].target_name,
    voterNames: rows[0].voter_names || [],
    votesRequired: votesRequired(),
  };
}

module.exports = { castVote, votesRequired, sweepExpired, proposalForDisplay };
