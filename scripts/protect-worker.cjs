// The watcher behind /protect. Run it with: npm run protect
//
// Everything else in this app is serverless, and that is the whole reason this file is
// separate. Discord will not tell an HTTPS endpoint that somebody got muted; it only
// pushes that down a gateway connection, to a process that stays connected. Vercel has no
// such process — it wakes the app for a request and freezes it again — so this is the one
// piece that has to run somewhere always on. A Raspberry Pi, an old laptop, Railway, Fly:
// anywhere that keeps a websocket open.
//
// It is event-driven rather than a loop. Polling "is he still muted?" every second would
// cost 60 lookups a minute per person and Discord allows about 15, so a poll would be rate
// limited into uselessness. A VOICE_STATE_UPDATE arrives the moment someone is muted, and
// carries the new state with it, so the watcher reacts in about a tenth of a second and
// spends nothing until something actually happens.
//
// No websocket library: Node has had a global WebSocket since 22, and the gateway protocol
// used here is four opcodes.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');

// Read the token even when it is commented out in .env, the same way the register script
// does, so the live bot can be watched without pointing local dev at production.
function fromEnvFile(name) {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  const m = fs.readFileSync(envPath, 'utf8').match(new RegExp('^#?\\s*' + name + '=(.+)$', 'm'));
  return m ? m[1].trim() : '';
}
if (!process.env.DISCORD_BOT_TOKEN) {
  process.env.DISCORD_BOT_TOKEN = fromEnvFile('DISCORD_BOT_TOKEN');
}

// And the database, for the same reason but it matters more here. /protect runs on Vercel
// and writes its rows to the live database, so a watcher pointed at the local PGlite file
// would sit watching an empty table and never undo anything — the feature would look
// broken rather than absent.
//
// So this defaults to the live database and says so on startup, which is the opposite of
// every other entry point: DATABASE_URL commented out and USE_PGLITE=1 exist to keep local
// DEV off production, and a process whose whole job is watching a live Discord server is
// not local dev. Pass --local to follow .env instead.
//
// It has to happen before src/db is required, because that picks its driver at load time.
if (!process.argv.includes('--local')) {
  const url = process.env.DATABASE_URL || fromEnvFile('DATABASE_URL');
  if (/^postgres/.test(url)) {
    process.env.DATABASE_URL = url;
    delete process.env.USE_PGLITE;
  }
}

const bot = require('../src/discordBot');
const { query, label } = require('../src/db');
const { reversal, expireProtections } = require('../src/voiceGuard');

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

// GUILDS (1 << 0) for the GUILD_CREATE that carries the voice states already in progress,
// GUILD_VOICE_STATES (1 << 7) for the updates themselves. Neither is privileged, so there
// is nothing to switch on in the portal for these — unlike the members intent.
const INTENTS = (1 << 0) | (1 << 7);

const HEARTBEAT = 1;
const IDENTIFY = 2;
const RESUME = 6;
const RECONNECT = 7;
const INVALID_SESSION = 9;
const HELLO = 10;
const HEARTBEAT_ACK = 11;
const DISPATCH = 0;

const log = (...parts) =>
  console.log(new Date().toISOString().slice(11, 19) + '  ' + parts.join(' '));

// --- who is protected ------------------------------------------------------------
//
// Cached, because a mute war can produce a burst of events and each one would otherwise be
// a round trip to Neon. Five seconds is stale enough to be cheap; a state that looks like
// it needs undoing for someone NOT in the cache forces a refresh first, so /protect takes
// effect immediately rather than up to five seconds later.
let cache = { at: 0, byGuild: new Map() };

async function refresh() {
  const { rows } = await query(
    'SELECT guild_id, discord_id FROM voice_protections WHERE expires_at > now()'
  );
  const byGuild = new Map();
  for (const row of rows) {
    if (!byGuild.has(row.guild_id)) byGuild.set(row.guild_id, new Set());
    byGuild.get(row.guild_id).add(row.discord_id);
  }
  cache = { at: Date.now(), byGuild };
  return cache;
}

async function isProtected(guildId, userId) {
  if (Date.now() - cache.at > 5000) await refresh();
  if (cache.byGuild.get(guildId)?.has(userId)) return true;

  // Not in the cache. Somebody may have run /protect a second ago.
  if (Date.now() - cache.at > 1000) {
    await refresh();
    return Boolean(cache.byGuild.get(guildId)?.has(userId));
  }
  return false;
}

// --- the actual protecting -------------------------------------------------------

async function handleVoiceState(state) {
  const undo = reversal(state);
  if (!undo) return;                       // left voice, or only muted themselves
  if (!state.guild_id || !state.user_id) return;
  if (!(await isProtected(state.guild_id, state.user_id))) return;

  // No cap: while a protection is live, every server mute gets undone, however many times
  // someone tries. The hour the protection lasts is what ends a mute war now, and Discord's
  // own 429 is the only other brake — which shows up in the log below rather than being
  // pre-empted.
  const result = await bot.setVoiceFlags(state.guild_id, state.user_id, undo);
  if (result.ok) {
    log('undid', JSON.stringify(undo), 'on', state.user_id);
    return;
  }

  // 50013 here almost always means the muter outranks the bot, which no amount of
  // retrying will fix.
  log('could NOT undo it on', state.user_id, '— code', result.code ?? result.status);
  if (result.code === 50013) {
    log('  the bot\'s role has to sit above whoever did the muting');
  }
}

// Anyone already sitting there server-muted when the watcher connects, or when it comes
// back after a restart. GUILD_CREATE carries the guild's current voice states.
async function sweep(guild) {
  for (const state of guild.voice_states || []) {
    await handleVoiceState({ ...state, guild_id: guild.id });
  }
}

// --- letting protections lapse ---------------------------------------------------
//
// Checked on a timer rather than driven by an event, because nothing happens in Discord
// when an hour passes. Half a minute is close enough for something measured in hours, and
// it is one small DELETE against a table with a handful of rows.
const SWEEP_EVERY_MS = 30_000;

async function sweepExpired() {
  try {
    const ended = await expireProtections({
      query,
      log,
      notify: async ({ discord_id: userId }) => {
        const sent = await bot.dmUser(
          userId,
          'Your voice protection has run out, so a server mute or deafen will stick again. '
          + 'Run `/protect` if you want another hour.'
        );
        // 50007 is "this person does not accept DMs from the server" — their choice.
        if (!sent.ok && sent.code !== 50007) {
          log('DM to', userId, 'failed — code', sent.code ?? sent.status);
        }
      },
    });

    for (const row of ended) {
      log('protection lapsed for', row.discord_id);
      // The cache would otherwise keep undoing mutes for up to five more seconds.
      cache.at = 0;
    }
  } catch (err) {
    console.error('expiry sweep failed: ' + err.message);
  }
}

// --- gateway ---------------------------------------------------------------------

let socket = null;
let seq = null;
let sessionId = null;
let resumeUrl = null;
let beat = null;
let acked = true;
let backoff = 1000;
let stopping = false;

function send(op, d) {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ op, d }));
}

function startHeartbeat(interval) {
  clearInterval(beat);
  acked = true;
  // Discord asks for a random first delay so a fleet of bots does not beat in lockstep.
  setTimeout(() => {
    if (stopping) return;
    send(HEARTBEAT, seq);
    beat = setInterval(() => {
      // A missed ACK means the connection is a zombie: the socket looks open and nothing
      // is getting through. Dropping it forces a resume.
      if (!acked) {
        log('no heartbeat ack — reconnecting');
        socket?.close(4000);
        return;
      }
      acked = false;
      send(HEARTBEAT, seq);
    }, interval);
  }, Math.random() * interval);
}

function connect() {
  if (stopping) return;
  const url = sessionId && resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : GATEWAY;
  log('connecting to', sessionId ? 'resume' : 'gateway');

  socket = new WebSocket(url);

  socket.addEventListener('message', async (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }

    if (frame.s !== null && frame.s !== undefined) seq = frame.s;

    try {
      if (frame.op === HELLO) {
        startHeartbeat(frame.d.heartbeat_interval);
        if (sessionId) {
          send(RESUME, { token: process.env.DISCORD_BOT_TOKEN, session_id: sessionId, seq });
        } else {
          send(IDENTIFY, {
            token: process.env.DISCORD_BOT_TOKEN,
            intents: INTENTS,
            properties: { os: process.platform, browser: 'gpoints', device: 'gpoints' },
          });
        }
        return;
      }

      if (frame.op === HEARTBEAT_ACK) { acked = true; return; }

      if (frame.op === RECONNECT) { socket.close(4000); return; }

      if (frame.op === INVALID_SESSION) {
        // d === false means the session is gone for good and a fresh identify is needed.
        if (!frame.d) { sessionId = null; resumeUrl = null; }
        socket.close(4000);
        return;
      }

      if (frame.op !== DISPATCH) return;

      if (frame.t === 'READY') {
        sessionId = frame.d.session_id;
        resumeUrl = frame.d.resume_gateway_url;
        backoff = 1000;
        log('ready as', frame.d.user?.username, '— watching', await countProtected(), 'protected');
        return;
      }

      if (frame.t === 'RESUMED') { backoff = 1000; log('resumed'); return; }

      if (frame.t === 'GUILD_CREATE') { await sweep(frame.d); return; }

      if (frame.t === 'VOICE_STATE_UPDATE') { await handleVoiceState(frame.d); return; }
    } catch (err) {
      // One bad event must not take the watcher down.
      console.error('handling ' + (frame.t || frame.op) + ' failed: ' + err.message);
    }
  });

  socket.addEventListener('close', (event) => {
    clearInterval(beat);
    if (stopping) return;

    // 4004 is a bad token and 4014 a disallowed intent: both stay broken however many
    // times we try, so say which and stop rather than loop forever.
    if (event.code === 4004) {
      console.error('Discord rejected the token. Check DISCORD_BOT_TOKEN.');
      process.exit(1);
    }
    if (event.code === 4014) {
      console.error('Discord refused the intents. GUILD_VOICE_STATES is not privileged, so '
        + 'this usually means the bot was removed from the application.');
      process.exit(1);
    }

    log('disconnected (' + event.code + ') — retrying in ' + backoff + 'ms');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });

  socket.addEventListener('error', () => { /* close always follows */ });
}

async function countProtected() {
  const { rows } = await query('SELECT count(*)::int AS c FROM voice_protections');
  return rows[0].c;
}

(async () => {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN is not set. Put it in .env, or run with it exported.');
    process.exit(1);
  }

  console.log('G Points voice watcher');
  console.log('  database: ' + label);

  try {
    await refresh();
  } catch (err) {
    console.error('Could not read voice_protections: ' + err.message);
    console.error('Apply the migration first:  npm run db:migrate');
    process.exit(1);
  }

  connect();
  await sweepExpired();
  setInterval(sweepExpired, SWEEP_EVERY_MS);
})();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(beat);
    socket?.close(1000);
    log('stopped — nobody is being watched now');
    process.exit(0);
  });
}
