require('dotenv').config();
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { query } = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const app = express();
app.set('trust proxy', 1); // behind Vercel's proxy

// Mounted before the JSON parser and with a raw body: Discord signs the exact bytes it
// sends, so they have to be verified before anything parses or reshapes them.
app.use(
  '/api/discord/interactions',
  express.raw({ type: '*/*', limit: '256kb' }),
  require('./routes/discordInteractions')
);

app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

const PUBLIC = path.join(__dirname, '..', 'public');

app.get('/api/health', async (req, res) => {
  try {
    const bot = require('./discordBot');
    const { rows } = await query('SELECT count(*)::int AS users FROM users');
    const { rows: s } = await query(
      'SELECT name FROM seasons WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1'
    );
    res.json({
      ok: true,
      users: rows[0].users,
      season: s[0]?.name ?? null,
      // Handy when setting Discord up: says which half of it is configured.
      discordVoting: bot.configured(),
      appVoting: bot.appVotingEnabled(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/me', requireAuth, require('./routes/account'));
app.use('/api/proposals', requireAuth, require('./routes/proposals'));
app.use('/api/leaderboard', requireAuth, require('./routes/leaderboard'));
app.use('/api/seasons', requireAuth, require('./routes/seasons'));
app.use('/api/admin', requireAuth, requireAdmin, require('./routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint' }));

// Pretty URLs: /propose serves public/propose.html
app.use(express.static(PUBLIC, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something broke on the server.' });
});

module.exports = app;
