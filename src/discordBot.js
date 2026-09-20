// Discord voting.
//
// A webhook can only push messages out. To let people vote from Discord the app needs a
// real Discord application: a bot token to post messages carrying buttons, and a public
// key to verify the interactions Discord sends back when those buttons are clicked.
//
// No always-on process is involved. Discord POSTs each click to an HTTPS endpoint, so
// this still works on serverless.

const crypto = require('node:crypto');

const API = 'https://discord.com/api/v10';

const token = () => (process.env.DISCORD_BOT_TOKEN || '').trim();
const publicKey = () => (process.env.DISCORD_PUBLIC_KEY || '').trim();
const channelId = () => (process.env.DISCORD_CHANNEL_ID || '').trim();

// Voting from Discord needs all three: somewhere to post, permission to post, and a key
// to trust what comes back.
const configured = () => Boolean(token() && publicKey() && channelId());

// App voting turns itself off once Discord voting is working, so there is exactly one
// place to vote. APP_VOTING=on or =off overrides the automatic choice.
function appVotingEnabled() {
  const override = (process.env.APP_VOTING || '').trim().toLowerCase();
  if (override === 'on' || override === 'true') return true;
  if (override === 'off' || override === 'false') return false;
  return !configured();
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        Authorization: 'Bot ' + token(),
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`Discord API ${options.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, body: text ? JSON.parse(text) : null };
  } catch (err) {
    console.error('Discord API call failed: ' + err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// --- signature verification ------------------------------------------------------
//
// Discord signs every interaction with Ed25519. An unverified endpoint would let anyone
// on the internet forge votes, so this is the security boundary of the whole feature.
// Node verifies Ed25519 natively; no library needed.
function verifySignature({ signature, timestamp, rawBody }) {
  const key = publicKey();
  if (!key || !signature || !timestamp) return false;
  try {
    const verifier = crypto.createPublicKey({
      key: Buffer.concat([
        // DER prefix for an Ed25519 public key, followed by the 32 raw key bytes.
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(key, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]),
      verifier,
      Buffer.from(signature, 'hex')
    );
  } catch (err) {
    console.error('Discord signature check failed: ' + err.message);
    return false;
  }
}

// --- message building ------------------------------------------------------------

const escapeMarkdown = (s) =>
  String(s ?? '').replace(/([\\`*_~|>])/g, '\\$1').slice(0, 300);

const amountLine = (kind, amount) =>
  (kind === 'award' ? '+' : '−') + Number(amount).toLocaleString() + ' G';

function proposalMessage({ id, kind, amount, reason, proposerName, targetName,
                           accepts = 0, rejects = 0, votesRequired, status = 'open',
                           voterNames = [] }) {
  const settled = status !== 'open';
  const pips = '🟩'.repeat(Math.min(accepts, votesRequired))
    + '⬛'.repeat(Math.max(0, votesRequired - accepts));

  const title = status === 'approved' ? `✅ ${amountLine(kind, amount)} → ${escapeMarkdown(targetName)}`
    : status === 'rejected' ? `❌ Rejected — ${amountLine(kind, amount)} for ${escapeMarkdown(targetName)}`
    : status === 'cancelled' ? `🚫 Withdrawn — ${amountLine(kind, amount)} for ${escapeMarkdown(targetName)}`
    : status === 'expired' ? `⌛ Expired — ${amountLine(kind, amount)} for ${escapeMarkdown(targetName)}`
    : `${amountLine(kind, amount)} → ${escapeMarkdown(targetName)}`;

  const fields = [
    { name: 'Proposed by', value: escapeMarkdown(proposerName), inline: true },
    { name: 'Votes', value: `${pips}  ${accepts}/${votesRequired}`, inline: true },
  ];
  if (rejects > 0) fields.push({ name: 'Rejected by', value: String(rejects), inline: true });
  if (voterNames.length) {
    fields.push({ name: 'Voted', value: voterNames.map(escapeMarkdown).join(', ').slice(0, 900) });
  }

  return {
    embeds: [{
      title,
      description: `"${escapeMarkdown(reason)}"`,
      color: settled
        ? (status === 'approved' ? (kind === 'award' ? 0x4ec98b : 0xf2685c) : 0x9aa3b2)
        : 0x7c8cf8,
      fields,
      footer: {
        text: settled
          ? `${accepts} accepted · ${rejects} rejected`
          : `${escapeMarkdown(proposerName)} and ${escapeMarkdown(targetName)} cannot vote`,
      },
    }],
    // Buttons disappear once the vote is over, so a settled proposal cannot be clicked.
    components: settled ? [] : [{
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Accept', custom_id: `vote:${id}:accept`, emoji: { name: '✅' } },
        { type: 2, style: 4, label: 'Reject', custom_id: `vote:${id}:reject`, emoji: { name: '❌' } },
      ],
    }],
    allowed_mentions: { parse: [] },
  };
}

// The application id is the first segment of the bot token, base64url encoded. Deriving
// it saves asking for yet another environment variable.
function applicationId() {
  const explicit = (process.env.DISCORD_APPLICATION_ID || '').trim();
  if (explicit) return explicit;
  const first = token().split('.')[0];
  if (!first) return '';
  try {
    return Buffer.from(first, 'base64').toString('utf8').replace(/\D/g, '');
  } catch {
    return '';
  }
}

// Posts to an explicit channel when given one, so /propose lands where it was typed
// rather than in the configured channel.
const postProposal = (proposal, toChannel) =>
  api(`/channels/${toChannel || channelId()}/messages`, {
    method: 'POST',
    body: JSON.stringify(proposalMessage(proposal)),
  });

const editProposal = (messageId, proposal, inChannel) =>
  api(`/channels/${inChannel || channelId()}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify(proposalMessage(proposal)),
  });

// The slash commands this app registers. Kept here so the registration script and the
// handler cannot disagree about names or option order.
const COMMANDS = [
  {
    name: 'propose',
    description: 'Propose awarding or deducting G points',
    options: [
      {
        name: 'user', description: 'Who is receiving', type: 3, required: true,
        autocomplete: true, // completes over G Points members, not Discord members
      },
      {
        name: 'type', description: 'Award or deduct', type: 3, required: true,
        choices: [
          { name: 'Award  (+)', value: 'award' },
          { name: 'Deduct (−)', value: 'deduct' },
        ],
      },
      {
        name: 'amount', description: 'How many, 1 to 100000', type: 4, required: true,
        min_value: 1, max_value: 100000,
      },
      { name: 'why', description: 'Make the case. Everyone sees this.', type: 3, required: true },
    ],
  },
];

module.exports = {
  configured, appVotingEnabled, verifySignature, proposalMessage, applicationId,
  postProposal, editProposal, api, escapeMarkdown, COMMANDS, channelId,
};
