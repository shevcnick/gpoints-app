// Discord button clicks land here.
//
// This endpoint is public — Discord calls it, so anyone on the internet can too. Every
// request is verified against the application's Ed25519 public key before it is trusted;
// without that, forging a vote would be a plain HTTP POST.
//
// Discord requires a reply within 3 seconds, so the work here stays small.

const router = require('express').Router();
const { query } = require('../db');
const bot = require('../discordBot');
const { castVote, proposalForDisplay } = require('../voting');

const PING = 1;
const MESSAGE_COMPONENT = 3;

const PONG = 1;
const UPDATE_MESSAGE = 7;
const EPHEMERAL = 64; // only the clicker sees it

const reply = (content) => ({
  type: 4,
  data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
});

// Interactions arrive as a raw body so the signature can be checked over the exact bytes
// Discord signed; JSON.parse after, never before.
router.post('/', async (req, res) => {
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');
  const rawBody = req.body;

  if (!bot.verifySignature({ signature, timestamp, rawBody })) {
    return res.status(401).send('invalid request signature');
  }

  let interaction;
  try {
    interaction = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
  } catch {
    return res.status(400).send('bad payload');
  }

  // Discord verifies the endpoint by sending a PING it expects to be PONGed.
  if (interaction.type === PING) return res.json({ type: PONG });

  if (interaction.type !== MESSAGE_COMPONENT) {
    return res.json(reply('That is not something I know how to handle.'));
  }

  try {
    const customId = String(interaction.data?.custom_id || '');
    const [action, rawId, choice] = customId.split(':');
    if (action !== 'vote') return res.json(reply('Unknown button.'));

    const proposalId = Number(rawId);
    if (!Number.isInteger(proposalId)) return res.json(reply('Bad proposal.'));

    // member.user in a server, user in a DM.
    const discordId = interaction.member?.user?.id || interaction.user?.id;
    if (!discordId) return res.json(reply('Could not tell who you are.'));

    const { rows } = await query(
      'SELECT id, display_name FROM users WHERE discord_id = $1', [discordId]
    );
    const voter = rows[0];

    if (!voter) {
      // Unlinked Discord account. Hand over a one-time code rather than guessing who
      // this is — votes have to be attributable to a real member.
      const code = await issueLinkCode(discordId);
      const site = (process.env.APP_URL || '').replace(/\/$/, '');
      return res.json(reply(
        'Your Discord account is not linked to a G Points account yet.\n\n'
        + `Go to ${site ? site + '/account' : 'the app, Account page'} and enter this code:\n`
        + `**${code}**\n\nIt is good for 15 minutes. Then click the button again.`
      ));
    }

    const result = await castVote({ proposalId, voterId: voter.id, vote: choice });

    if (result.code !== 200) {
      return res.json(reply(result.body.error));
    }

    // Redraw the message in place: new tally, and buttons removed once it is settled.
    const fresh = await proposalForDisplay(proposalId);
    if (fresh) {
      const message = bot.proposalMessage({ ...fresh, id: proposalId });
      return res.json({ type: UPDATE_MESSAGE, data: message });
    }

    return res.json(reply('Vote counted.'));
  } catch (err) {
    console.error('Discord interaction failed: ' + err.message);
    // Always answer Discord, or the user sees "This interaction failed".
    return res.json(reply('Something went wrong handling that vote.'));
  }
});

// Six characters, unambiguous alphabet (no O/0, I/1), valid for 15 minutes.
async function issueLinkCode(discordId) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const crypto = require('node:crypto');
  const code = Array.from(crypto.randomBytes(6))
    .map((b) => alphabet[b % alphabet.length])
    .join('');

  // Stored against the Discord id, not a user — nobody has claimed it yet.
  await query(
    `INSERT INTO discord_link_codes (code, discord_id, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')
     ON CONFLICT (discord_id) DO UPDATE
       SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at`,
    [code, discordId]
  );
  return code;
}

module.exports = router;
