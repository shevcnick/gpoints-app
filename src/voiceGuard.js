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

// A cap on how hard the watcher will argue.
//
// Someone with the permission can re-mute as fast as the bot un-mutes, and both sides burn
// Discord's member-edit limit doing it. Past a few rounds a minute the bot stops, says so
// once, and lets the mute stand: losing the argument loudly beats spinning silently.
// One verdict per attempt, so the caller never has to count anything itself:
//
//   'go'    undo it
//   'quit'  over the cap — leave the mute alone, and say so
//   'hush'  over the cap and already said so, so stay quiet
function throttle({ perMinute = 6, now = () => Date.now() } = {}) {
  const seen = new Map();   // key -> timestamps inside the last minute
  const told = new Set();   // keys already complained about

  return {
    consume(key) {
      const cutoff = now() - 60_000;
      const times = (seen.get(key) || []).filter((t) => t > cutoff);
      seen.set(key, times);

      if (times.length >= perMinute) {
        if (told.has(key)) return 'hush';
        told.add(key);
        return 'quit';
      }

      times.push(now());
      // A key back under the cap may complain again next time it goes over.
      told.delete(key);
      return 'go';
    },
  };
}

module.exports = { reversal, throttle };
