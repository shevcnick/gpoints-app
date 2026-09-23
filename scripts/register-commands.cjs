// Registers this app's slash commands with Discord. Run once, and again whenever the
// command definitions in src/discordBot.js change.
//
//   npm run discord:register            -- global, appears everywhere, up to 1h to show
//   npm run discord:register <guildId>  -- one server, appears instantly (better for testing)
//
// Reads DISCORD_BOT_TOKEN from .env, including when it is commented out, so the live
// bot can be configured without pointing local dev at production.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');

function fromEnvFile(name) {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  const m = fs.readFileSync(envPath, 'utf8').match(new RegExp('^#?\\s*' + name + '=(.+)$', 'm'));
  return m ? m[1].trim() : '';
}

(async () => {
  if (!process.env.DISCORD_BOT_TOKEN) {
    process.env.DISCORD_BOT_TOKEN = fromEnvFile('DISCORD_BOT_TOKEN');
  }
  const bot = require('../src/discordBot');

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('DISCORD_BOT_TOKEN is not set. Put it in .env, or run with it exported.');
    process.exit(1);
  }

  const appId = bot.applicationId();
  if (!appId) {
    console.error('Could not work out the application id from the bot token.');
    console.error('Set DISCORD_APPLICATION_ID in .env (Developer Portal -> General Information).');
    process.exit(1);
  }

  const guildId = process.argv[2];
  const url = guildId
    ? `/applications/${appId}/guilds/${guildId}/commands`
    : `/applications/${appId}/commands`;

  console.log('Application ' + appId);
  console.log(guildId ? 'Registering to server ' + guildId : 'Registering globally');

  const res = await bot.api(url, {
    method: 'PUT', // PUT replaces the whole set, so removed commands disappear
    body: JSON.stringify(bot.COMMANDS),
  });

  if (!res.ok) {
    console.error('Registration failed. Check the bot token is right.');
    process.exit(1);
  }

  // Print the limits Discord now holds, not the ones we sent: command definitions live
  // on Discord's side, so changing them in code does nothing until this runs.
  for (const c of res.body) {
    console.log('  /' + c.name + ' — ' + c.description);
    for (const o of c.options || []) {
      const range = o.max_value !== undefined
        ? ` (${(o.min_value ?? 0).toLocaleString()} to ${o.max_value.toLocaleString()})`
        : '';
      console.log('      ' + o.name + range);
    }
  }
  console.log(
    guildId
      ? '\nDone. It should appear in that server immediately.'
      : '\nDone. Global commands can take up to an hour to appear everywhere.'
      + '\nPass your server id to register instantly there instead:'
      + '\n  npm run discord:register -- <serverId>'
  );
  // No process.exit here: forcing exit while sockets are still closing makes libuv
  // print an assertion failure on Windows. Nothing is holding the loop open, so it
  // ends on its own.
})().catch((err) => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
