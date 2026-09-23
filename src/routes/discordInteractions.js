// Discord button clicks land here.
//
// This endpoint is public — Discord calls it, so anyone on the internet can too. Every
// request is verified against the application's Ed25519 public key before it is trusted;
// without that, forging a vote would be a plain HTTP POST.
//
// Discord requires a reply within 3 seconds, so the work here stays small.

const router = require('express').Router();
const { query, activeSeason } = require('../db');
const bot = require('../discordBot');
const { castVote, proposalForDisplay, votesRequired } = require('../voting');

const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const AUTOCOMPLETE = 4;

const PONG = 1;
const UPDATE_MESSAGE = 7;
const AUTOCOMPLETE_RESULT = 8;
const EPHEMERAL = 64; // only the clicker sees it

const MAX_AMOUNT = 1000000000;

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

  try {
    if (interaction.type === AUTOCOMPLETE) {
      return res.json(await autocompleteMembers(interaction));
    }

    if (interaction.type === APPLICATION_COMMAND) {
      return res.json(await handleCommand(interaction));
    }

    if (interaction.type !== MESSAGE_COMPONENT) {
      return res.json(reply('That is not something I know how to handle.'));
    }

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

// Completes the "user" option over G Points members. Deliberately not Discord members:
// points belong to app accounts, and the person receiving them does not need to have
// linked their own Discord for someone to propose points for them.
async function autocompleteMembers(interaction) {
  const option = (interaction.data?.options || []).find((o) => o.focused);
  const typed = String(option?.value || '').toLowerCase();

  const { rows } = await query(
    `SELECT id, display_name, avatar_emoji FROM users
     WHERE $1 = '' OR lower(display_name) LIKE '%' || $1 || '%'
     ORDER BY display_name LIMIT 25`,
    [typed]
  );

  return {
    type: AUTOCOMPLETE_RESULT,
    data: {
      // The value carries the user id, so the command handler never has to guess who
      // was meant from a display name that might not be unique.
      choices: rows.map((u) => ({
        name: `${u.avatar_emoji} ${u.display_name}`.slice(0, 100),
        value: String(u.id),
      })),
    },
  };
}

async function handleCommand(interaction) {
  if (interaction.data?.name !== 'propose') return reply('Unknown command.');

  const discordId = interaction.member?.user?.id || interaction.user?.id;
  if (!discordId) return reply('Could not tell who you are.');

  const { rows: me } = await query(
    'SELECT id, display_name FROM users WHERE discord_id = $1', [discordId]
  );
  if (!me[0]) {
    const code = await issueLinkCode(discordId);
    const site = (process.env.APP_URL || '').replace(/\/$/, '');
    return reply(
      'Link your Discord to your G Points account first.\n\n'
      + `Go to ${site ? site + '/account' : 'the app, Account page'} and enter:\n`
      + `**${code}**\n\nGood for 15 minutes.`
    );
  }

  const options = Object.fromEntries(
    (interaction.data.options || []).map((o) => [o.name, o.value])
  );

  const targetId = Number(options.user);
  if (!Number.isInteger(targetId))
    return reply('Pick who is receiving from the list as you type.');
  if (targetId === me[0].id)
    return reply("You can't propose points for yourself.");

  const { rows: target } = await query(
    'SELECT id, display_name FROM users WHERE id = $1', [targetId]
  );
  if (!target[0]) return reply('That person is not a G Points member.');

  const kind = options.type;
  if (kind !== 'award' && kind !== 'deduct') return reply('Pick award or deduct.');

  const amount = Number(options.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT)
    return reply(`How many must be a whole number between 1 and ${MAX_AMOUNT.toLocaleString()}.`);

  const why = String(options.why || '').trim();
  if (!why) return reply('You have to say why.');
  if (why.length > 280) return reply('Keep the reason under 280 characters.');

  const season = await activeSeason();
  const { rows: created } = await query(
    `INSERT INTO proposals (season_id, proposer_id, target_id, kind, amount, reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [season.id, me[0].id, target[0].id, kind, amount, why]
  );
  const id = created[0].id;

  // Every proposal lands in the G Points channel wherever the command was typed, so the
  // voting all happens in one place. Falls back to the current channel if no channel is
  // configured, rather than losing the proposal.
  const channel = bot.channelId() || interaction.channel_id;

  // Posted via the API rather than as the interaction reply, so the message id comes
  // back and can be stored for editing the tally later.
  const posted = await bot.postProposal({
    id, kind, amount, reason: why,
    proposerName: me[0].display_name,
    targetName: target[0].display_name,
    votesRequired: votesRequired(),
  }, channel);

  if (!posted.ok) {
    // With voting in Discord, a proposal nobody can see is a proposal nobody can vote
    // on. Undo it rather than leaving it stranded in the database.
    await query('DELETE FROM proposals WHERE id = $1', [id]);
    return reply(
      'Could not post that in the G Points channel, so nothing was created.\n\n'
      + bot.explainFailure(posted)
    );
  }

  await query(
    'UPDATE proposals SET discord_message_id = $1, discord_channel_id = $2 WHERE id = $3',
    [posted.body.id, channel, id]
  );

  // A jump link, so whoever ran the command can follow it even from another channel.
  const guild = interaction.guild_id;
  const link = guild
    ? `https://discord.com/channels/${guild}/${channel}/${posted.body.id}`
    : null;

  return reply(
    `Posted in <#${channel}> — ${votesRequired()} neutral friends need to accept it.`
    + (link ? `\n${link}` : '')
  );
}

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
