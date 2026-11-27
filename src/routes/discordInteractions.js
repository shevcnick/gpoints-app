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
const { getStandings, withRanks } = require('../standings');

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

// Discord permission bits.
const PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
};

// Shared by the voice commands.
//
// Deliberately gated on the caller's own DISCORD permission rather than on G Points
// admin: if Discord already trusts you to do this by right-clicking someone, the bot
// should not second-guess it — and it means nobody has to link an account first.
// Interactions carry the invoking member's computed permissions as a bitfield string.
function voiceCommandContext(interaction, needed, { target = true } = {}) {
  const guildId = interaction.guild_id;
  if (!guildId) return { error: reply('This only works in a server.') };

  const callerDiscordId = interaction.member?.user?.id || interaction.user?.id;
  if (!callerDiscordId) return { error: reply('Could not tell who you are.') };

  let held = 0n;
  try { held = BigInt(interaction.member?.permissions || '0'); } catch { held = 0n; }
  const allowed = (held & PERMISSIONS.ADMINISTRATOR) !== 0n
    || (held & PERMISSIONS[needed]) !== 0n;
  if (!allowed) {
    return {
      error: reply(`You need the **${needed.replace('_', ' ').toLowerCase()}** permission `
        + 'in this server to do that.'),
    };
  }

  if (!target) return { guildId, callerDiscordId };

  const targetId = String(
    (interaction.data.options || []).find((o) => o.name === 'user')?.value || ''
  );
  if (!targetId) return { error: reply('Pick someone.') };

  return { guildId, callerDiscordId, targetId };
}

// Turns a failed member edit into the thing to actually go and fix.
function explainMemberEdit(result, permission) {
  if (result.code === 40032) return 'They are not in a voice channel.';
  if (result.code === 50013) {
    return `I do not have permission. The bot needs **${permission}**, and its role has `
      + 'to sit above theirs in the server role list.';
  }
  return 'That did not work. ' + bot.explainFailure(result);
}

async function handleDeafen(interaction, deaf) {
  const ctx = voiceCommandContext(interaction, 'DEAFEN_MEMBERS');
  if (ctx.error) return ctx.error;

  if (deaf && ctx.targetId === ctx.callerDiscordId)
    return reply('You cannot bait yourself.');

  const result = await bot.setDeafened(ctx.guildId, ctx.targetId, deaf);
  if (!result.ok) return reply(explainMemberEdit(result, 'Deafen Members'));

  return {
    type: 4,
    data: {
      content: deaf ? `<@${ctx.targetId}> baited` : `<@${ctx.targetId}> unbaited`,
      // Scoped to the one person named, so this can never become an @everyone.
      allowed_mentions: { users: [ctx.targetId] },
    },
  };
}

// Members whose voice state is worth asking about, and how many of those questions to
// have in flight at once. Discord rate limits per route, and a friend-sized server is a
// few dozen calls, so a handful of lanes is the right amount of parallel.
const MAX_SCAN = 400;
const LANES = 8;

// How many people one /troll is allowed to deafen. One by default, so the command can be
// tried on a real channel without emptying it; TROLL_LIMIT=all takes the whole room, or
// set a number. Undoing is never capped — whatever /troll reached, /untroll can reach.
function trollLimit() {
  const raw = (process.env.TROLL_LIMIT || '').trim().toLowerCase();
  if (raw === 'all') return Infinity;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// Everything has to happen inside Discord's three seconds, so the scan gets a budget and
// hands back what it has when the budget runs out. A partial answer beats a timeout, and
// a timeout is all a deferred reply would buy here: see handleTroll.
const SCAN_BUDGET_MS = 2200;

// Who, of these candidates, is sitting in this channel.
//
// Chunk by chunk in member-list order rather than a free-for-all worker pool, because it
// stops as soon as it has enough people — so a capped /troll reads the first few members
// and goes, and it picks the same ones every time instead of whoever answered fastest.
async function occupantsOf(guildId, channel, candidates, wanted) {
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const found = [];
  let checked = 0;

  for (let i = 0; i < candidates.length; i += LANES) {
    const chunk = candidates.slice(i, i + LANES);
    const hits = await Promise.all(chunk.map(async (m) => {
      const state = await bot.voiceStateOf(guildId, m.user.id);
      return state.ok && state.body?.channel_id === channel ? m.user.id : null;
    }));
    checked += chunk.length;
    found.push(...hits.filter(Boolean));
    if (found.length >= wanted || Date.now() > deadline) break;
  }

  return { found, checked };
}

const announce = (content, users = []) => ({
  content,
  // Never a bare parse: a command that acts on a roomful of people must not be able to
  // turn into an @everyone.
  allowed_mentions: users.length ? { users: users.slice(0, 100) } : { parse: [] },
});

function explainMemberList(result) {
  if (result.code === 50001 || result.status === 403) {
    return 'I cannot read the member list, and without it there is no way to work out '
      + 'who is in a voice channel. Turn on **Server Members Intent** under Developer '
      + 'Portal, Bot, Privileged Gateway Intents.';
  }
  return 'Could not read the member list. ' + bot.explainFailure(result);
}

// Everyone in one voice channel, deafened or undeafened in one go.
//
// Gated on Deafen Members exactly like /deafen: this is the same action, just repeated,
// so it should not be easier to reach than doing it by hand. The caller is left out when
// deafening — self-targeting is refused everywhere else too — but included when lifting
// it, so whoever ran it can undo it on themselves as well.
// Answered in one go rather than deferred. A deferred reply would be the natural shape
// for work this chatty, but there is nowhere to run it: on Vercel the invocation ends
// when the response is flushed, so the follow-up never happens and the placeholder sits
// at "thinking…" forever. So the scan is budgeted to fit instead.
async function handleTroll(interaction, deaf) {
  const ctx = voiceCommandContext(interaction, 'DEAFEN_MEMBERS', { target: false });
  if (ctx.error) return ctx.error;

  const picked = String(
    (interaction.data.options || []).find((o) => o.name === 'channel')?.value || ''
  );

  // No ephemeral flag: like /deafen, the callout is the point.
  return { type: 4, data: await trollChannel({ ...ctx, picked, deaf }) };
}

async function trollChannel({ guildId, callerDiscordId, picked, deaf }) {
  let channel = picked;
  if (!channel) {
    const mine = await bot.voiceStateOf(guildId, callerDiscordId);
    channel = mine.ok ? mine.body?.channel_id : null;
    if (!channel) {
      return announce('Join a voice channel first, or pick one with the `channel` option.');
    }
  }

  const members = await bot.listMembers(guildId);
  if (!members.ok || !Array.isArray(members.body)) {
    return announce(explainMemberList(members));
  }

  // Bots have nothing to be deafened out of, and the caller is spared when deafening.
  const candidates = members.body
    .filter((m) => m.user && !m.user.bot)
    .filter((m) => !(deaf && m.user.id === callerDiscordId))
    .slice(0, MAX_SCAN);

  const wanted = deaf ? trollLimit() : Infinity;
  const { found: inChannel, checked } = await occupantsOf(guildId, channel, candidates, wanted);

  if (!inChannel.length) {
    return announce(
      (deaf ? `Nobody to bait in <#${channel}>.` : `Nobody is in <#${channel}>.`)
      + (checked < candidates.length
        ? ` (Only got through ${checked} of ${candidates.length} members before running out of time.)`
        : '')
    );
  }

  const present = inChannel.slice(0, wanted);

  // Capped at TROLL_LIMIT or a channel's worth, so a few chunks covers it.
  const done = [];
  const refused = [];
  for (let i = 0; i < present.length; i += LANES) {
    const results = await Promise.all(
      present.slice(i, i + LANES).map(async (id) => ({
        id, result: await bot.setDeafened(guildId, id, deaf),
      }))
    );
    for (const r of results) (r.result.ok ? done : refused).push(r);
  }

  if (!done.length) {
    return announce(
      (deaf ? 'Could not bait anyone. ' : 'Could not lift it off anyone. ')
      + explainMemberEdit(refused[0].result, 'Deafen Members')
    );
  }

  const ids = done.map((d) => d.id);
  // Named rather than counted while the list is short, which is the whole point of it.
  const named = ids.length <= 20
    ? ids.map((id) => `<@${id}>`).join(' ')
    : `${ids.length} of them`;

  const skipped = refused.length
    ? `\n(${refused.length} out of reach — the bot's role has to sit above theirs.)`
    : '';

  // Otherwise a /troll that quietly hit one of five looks broken rather than capped. The
  // scan stops once it has enough, so this counts what was asked for, not what is in there.
  const capped = deaf && Number.isFinite(wanted) && inChannel.length >= wanted
    ? `\n(TROLL_LIMIT is ${wanted} — set TROLL_LIMIT=all to take the room.)`
    : '';

  return announce(
    (deaf ? `🔇 ${named} baited in <#${channel}>` : `🔊 ${named} unbaited in <#${channel}>`)
      + capped + skipped,
    ids
  );
}

async function handleCommand(interaction) {
  if (interaction.data?.name === 'leaderboard') return handleLeaderboard(interaction);
  if (interaction.data?.name === 'troll') return handleTroll(interaction, true);
  if (interaction.data?.name === 'untroll') return handleTroll(interaction, false);
  if (interaction.data?.name === 'kick') return handleKick(interaction);
  if (interaction.data?.name === 'deafen') return handleDeafen(interaction, true);
  if (interaction.data?.name === 'undeafen') return handleDeafen(interaction, false);
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

// Boot someone out of voice, then say so publicly.
//
// Restricted to G Points admins. Discord gates this behind the Move Members permission
// for a reason: an open version lets anyone in the server disconnect anyone else,
// repeatedly, which stops being a joke quickly. Drop the admin check below if you want
// the whole group to have it.
async function handleKick(interaction) {
  const ctx = voiceCommandContext(interaction, 'MOVE_MEMBERS');
  if (ctx.error) return ctx.error;

  if (ctx.targetId === ctx.callerDiscordId) return reply('You cannot bait yourself.');

  const result = await bot.disconnectFromVoice(ctx.guildId, ctx.targetId);
  if (!result.ok) return reply(explainMemberEdit(result, 'Move Members'));

  return {
    type: 4,
    data: {
      content: `<@${ctx.targetId}> baited`,
      allowed_mentions: { users: [ctx.targetId] },
    },
  };
}

// Replying to the interaction itself puts the board in whichever channel the command was
// used in, with no posting permission needed — so this works even where the bot cannot
// post messages of its own.
async function handleLeaderboard(interaction) {
  const options = Object.fromEntries(
    (interaction.data.options || []).map((o) => [o.name, o.value])
  );
  const windowName = options.period || 'week';

  const data = await getStandings(windowName);
  if (!data) return reply('Pick week, month, year or all time.');

  const message = bot.leaderboardMessage({ ...data, standings: withRanks(data.standings) });

  // Type 4 without the ephemeral flag: everyone in the channel sees it.
  return { type: 4, data: message };
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
