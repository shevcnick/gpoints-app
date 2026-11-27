// The rules behind /protect, kept apart from the gateway plumbing that feeds them so they
// can be tested without a websocket.
//
// Discord reports two different kinds of silence on a voice state, and only one of them is
// something being done TO you:
//
//   deaf / mute            server mute and server deafen — somebody with the permission
//                          did this to you, and it is what /protect undoes
//   self_deaf / self_mute  you clicked the headphones or the microphone yourself
//
// Confusing the two would make the bot fight you every time you muted yourself, which is
// the obvious way to get this wrong.

// What to send back to Discord for this voice state, or null to leave it alone.
function reversal(state) {
  // Nobody can be server-muted outside a voice channel, and a state with no channel is
  // somebody leaving.
  if (!state || !state.channel_id) return null;

  const body = {};
  if (state.deaf) body.deaf = false;
  if (state.mute) body.mute = false;

  return Object.keys(body).length ? body : null;
}

// Protections whose time is up: dropped, and handed back so each person can be told.
//
// DELETE ... RETURNING does both halves in one statement, so two watchers running at once
// cannot both claim the same row and send the same person two messages.
async function expireProtections({ query, notify, log = () => {} }) {
  const { rows } = await query(
    `DELETE FROM voice_protections
      WHERE expires_at <= now()
      RETURNING guild_id, discord_id`
  );

  for (const row of rows) {
    try {
      await notify(row);
    } catch (err) {
      // Somebody who does not accept DMs is not a failure worth stopping for; their
      // protection is still gone either way.
      log('could not tell ' + row.discord_id + ' it lapsed: ' + err.message);
    }
  }

  return rows;
}

module.exports = { reversal, expireProtections };
