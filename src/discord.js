// Optional Discord notifications. Set DISCORD_WEBHOOK_URL and the group gets a message
// when a proposal opens, lands or is reversed — otherwise proposals sit unvoted because
// nobody thinks to check the site.
//
// Two rules hold throughout: a Discord problem must never fail a request that already
// succeeded, and text written by users must never be able to ping the server.

const TIMEOUT_MS = 3000;

const url = () => (process.env.DISCORD_WEBHOOK_URL || '').trim();
const enabled = () => /^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(url());

// Where to send people so they can act on the message.
const appUrl = () => (process.env.APP_URL || '').trim().replace(/\/$/, '');

const COLORS = {
  open: 0x7c8cf8,
  award: 0x4ec98b,
  deduct: 0xf2685c,
  rejected: 0x9aa3b2,
  reversed: 0xf2c14e,
};

// Discord renders markdown, so a reason containing * or ` would mangle the message.
const escapeMarkdown = (s) =>
  String(s ?? '').replace(/([\\`*_~|>])/g, '\\$1').slice(0, 300);

async function post(payload) {
  if (!enabled()) return { skipped: 'no webhook configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions with an empty parse list means nothing in this message can
      // ping anyone. Without it, "@everyone" in a reason would notify the whole server.
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('Discord webhook returned ' + res.status + ' ' + res.statusText);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    // Includes the abort on timeout. Never rethrow: the points were already awarded.
    console.error('Discord webhook failed: ' + err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const amountLine = (kind, amount) =>
  (kind === 'award' ? '+' : '−') + Number(amount).toLocaleString() + ' G';

function proposalOpened({ kind, amount, reason, proposerName, targetName, votesRequired }) {
  const link = appUrl();
  return post({
    embeds: [{
      title: `${amountLine(kind, amount)} → ${escapeMarkdown(targetName)}`,
      description: `"${escapeMarkdown(reason)}"`,
      color: COLORS.open,
      fields: [
        { name: 'Proposed by', value: escapeMarkdown(proposerName), inline: true },
        { name: 'Needs', value: `${votesRequired} neutral votes`, inline: true },
      ],
      footer: {
        text: `${escapeMarkdown(proposerName)} and ${escapeMarkdown(targetName)} cannot vote`,
      },
    }],
    content: link ? `🗳️ New proposal — vote at ${link}/pending` : '🗳️ New proposal',
  });
}

function proposalResolved({ kind, amount, reason, targetName, status, accepts, rejects }) {
  const approved = status === 'approved';
  return post({
    embeds: [{
      title: approved
        ? `✅ ${amountLine(kind, amount)} → ${escapeMarkdown(targetName)}`
        : `❌ Rejected — ${amountLine(kind, amount)} for ${escapeMarkdown(targetName)}`,
      description: `"${escapeMarkdown(reason)}"`,
      color: approved ? COLORS[kind] : COLORS.rejected,
      footer: { text: `${accepts} accepted · ${rejects} rejected` },
    }],
  });
}

function proposalReversed({ kind, amount, reason, targetName, adminName, reverseReason }) {
  return post({
    embeds: [{
      title: `↩️ Reversed — ${amountLine(kind, amount)} for ${escapeMarkdown(targetName)}`,
      description: `Was: "${escapeMarkdown(reason)}"`,
      color: COLORS.reversed,
      fields: [{ name: 'Reason', value: escapeMarkdown(reverseReason) || '—' }],
      footer: { text: 'Reversed by ' + escapeMarkdown(adminName) },
    }],
  });
}

module.exports = {
  enabled, post, proposalOpened, proposalResolved, proposalReversed, escapeMarkdown,
};
