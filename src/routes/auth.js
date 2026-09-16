const router = require('express').Router();
const { query } = require('../db');
const { hashPassword, verifyPassword, setSession, clearSession, requireAuth } = require('../auth');

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

router.post('/signup', async (req, res, next) => {
  try {
    const { inviteCode, username, displayName, password } = req.body || {};

    // Forgiving on case and stray whitespace: phone keyboards capitalise the first
    // letter and copy-paste drags spaces along, and neither should lock a friend out.
    const tidy = (s) => String(s ?? '').trim().toLowerCase();
    if (tidy(inviteCode) !== tidy(process.env.INVITE_CODE))
      return res.status(403).json({ error: 'Wrong invite code. Ask Nick for it.' });

    const uname = String(username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(uname))
      return res.status(400).json({
        error: 'Username must be 3-20 characters: lowercase letters, numbers or underscores.',
      });

    const name = String(displayName || '').trim();
    if (name.length < 1 || name.length > 30)
      return res.status(400).json({ error: 'Display name must be 1-30 characters.' });

    if (typeof password !== 'string' || password.length < 4)
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });

    // Whoever claims the owner's username is admin automatically, so Nick does not have
    // to go poking at the database after signing up.
    const owners = String(process.env.ADMIN_USERNAMES || 'nick')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const isAdmin = owners.includes(uname);

    const { rows } = await query(
      `INSERT INTO users (username, display_name, password_hash, is_admin)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, display_name, avatar_emoji, is_admin`,
      [uname, name, await hashPassword(password), isAdmin]
    );
    if (!rows[0]) return res.status(409).json({ error: 'That username is taken.' });

    setSession(res, rows[0].id);
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const uname = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    const { rows } = await query('SELECT * FROM users WHERE username = $1', [uname]);
    const user = rows[0];

    // Same message and a real bcrypt comparison either way, so response content and
    // timing don't reveal whether the username exists.
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(password, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });

    setSession(res, user.id);
    res.json({
      user: {
        id: user.id, username: user.username, display_name: user.display_name,
        avatar_emoji: user.avatar_emoji, is_admin: user.is_admin,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// Cheap check the frontend uses to decide whether to redirect to the login page.
router.get('/session', requireAuth, (req, res) => res.json({ user: req.user }));

module.exports = router;
