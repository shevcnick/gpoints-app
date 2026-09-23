// End-to-end test of the voting rules. Boots the real app on a random port, drives it
// over HTTP with real cookies, and asserts against the real database.
// Usage: node scripts/test.cjs   -- WIPES and reseeds the database it points at (dev only).
require('dotenv').config();
const assert = require('node:assert');
const fs = require('node:fs');
const { pool, query } = require('../src/db');
const app = require('../src/app');

let pass = 0;
let fail = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    results.push('  PASS  ' + name);
  } catch (err) {
    fail++;
    results.push('  FAIL  ' + name + '\n          ' + err.message);
  }
}

let base;
let signIt;            // set once a signing key exists, used by the Discord tests
let discordProposal;   // the proposal those tests vote on
const jars = {};

// Minimal cookie jar per username, so several "browsers" can act at once.
async function call(who, path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (jars[who]) headers.Cookie = jars[who];
  const res = await fetch(base + '/api' + path, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) jars[who] = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

const login = (who) =>
  call(who, '/auth/login', { method: 'POST', body: { username: who, password: 'test' } });
const propose = (who, body) => call(who, '/proposals', { method: 'POST', body });
const vote = (who, id, v) =>
  call(who, '/proposals/' + id + '/vote', { method: 'POST', body: { vote: v } });
const board = async (who, win) => (await call(who, '/leaderboard?window=' + win)).body.standings;

async function pointsOf(who, name, win) {
  const row = (await board(who, win || 'all')).find((s) => s.display_name === name);
  return row ? row.points : undefined;
}

const countRows = async (sql, params) => Number((await query(sql, params)).rows[0].c);

// The first thing this suite does is DROP every table. Against a remote database that
// destroys real data, so refuse unless the target is clearly local and disposable.
function refuseToWipeProduction() {
  const url = process.env.DATABASE_URL;
  if (!url) return; // PGlite, local file, fine
  const host = (url.match(/@([^/:]+)/) || [])[1] || '';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(host);
  if (isLocal || process.env.ALLOW_DESTRUCTIVE_TESTS === '1') return;

  console.error('\nREFUSING TO RUN.\n');
  console.error('  These tests DROP every table before they start, and DATABASE_URL points at');
  console.error('  a remote database:\n');
  console.error('      ' + host + '\n');
  console.error('  If that is your live app, running this would delete everyone\'s points.\n');
  console.error('  To test safely, comment out DATABASE_URL in .env and run again — the suite');
  console.error('  will use the local offline database instead.\n');
  console.error('  If you genuinely mean to wipe that remote database:');
  console.error('      ALLOW_DESTRUCTIVE_TESTS=1 npm test\n');
  process.exit(1);
}

async function main() {
  refuseToWipeProduction();

  // Fresh database every run.
  await query(fs.readFileSync('db/schema.sql', 'utf8'));
  await query(fs.readFileSync('db/seed.sql', 'utf8'));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  for (const who of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
    const r = await login(who);
    assert.strictEqual(r.status, 200, 'login ' + who + ' failed: ' + JSON.stringify(r.body));
  }

  const ids = {};
  for (const u of (await call('alice', '/me/others')).body.users) ids[u.display_name] = u.id;
  ids.Alice = (await call('alice', '/auth/session')).body.user.id;

  // ------------------------------------------------------------------ happy path
  let bobProposal;
  await check('award reaching 3 accepts applies the points', async () => {
    const r = await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 50, reason: 'carried the group project',
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    bobProposal = r.body.id;

    let res = await vote('carol', bobProposal, 'accept');
    assert.strictEqual(res.body.status, 'open', 'still open at 1/3');
    assert.strictEqual(res.body.accepts, 1);

    res = await vote('dave', bobProposal, 'accept');
    assert.strictEqual(res.body.status, 'open', 'still open at 2/3');

    res = await vote('erin', bobProposal, 'accept');
    assert.strictEqual(res.body.status, 'approved', 'approves on the 3rd accept');
    assert.strictEqual(await pointsOf('alice', 'Bob', 'week'), 50);
  });

  // ------------------------------------------------------------------ the blocks
  await check('proposer cannot vote on their own proposal', async () => {
    const p = (await propose('alice', {
      targetId: ids.Carol, kind: 'award', amount: 5, reason: 'x',
    })).body.id;
    const r = await vote('alice', p, 'accept');
    assert.strictEqual(r.status, 403, 'expected 403, got ' + r.status);
    assert.match(r.body.error, /proposed this/i);
  });

  await check('target cannot vote on points about themselves', async () => {
    const p = (await propose('alice', {
      targetId: ids.Carol, kind: 'deduct', amount: 5, reason: 'x',
    })).body.id;
    const r = await vote('carol', p, 'accept');
    assert.strictEqual(r.status, 403, 'expected 403, got ' + r.status);
    assert.match(r.body.error, /your own points/i);
  });

  await check('nobody can vote twice', async () => {
    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 5, reason: 'x',
    })).body.id;
    assert.strictEqual((await vote('carol', p, 'accept')).status, 200);
    const again = await vote('carol', p, 'accept');
    assert.strictEqual(again.status, 409, 'expected 409, got ' + again.status);
    assert.match(again.body.error, /already voted/i);
  });

  await check('cannot flip your vote by rejecting after accepting', async () => {
    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 5, reason: 'x',
    })).body.id;
    await vote('carol', p, 'accept');
    assert.strictEqual((await vote('carol', p, 'reject')).status, 409);
  });

  await check('cannot propose points for yourself', async () => {
    const r = await propose('alice', {
      targetId: ids.Alice, kind: 'award', amount: 10, reason: 'im great',
    });
    assert.strictEqual(r.status, 400, 'expected 400, got ' + r.status);
  });

  await check('voting on an already-approved proposal is refused', async () => {
    const r = await vote('frank', bobProposal, 'accept');
    assert.strictEqual(r.status, 409, 'expected 409, got ' + r.status);
    assert.match(r.body.error, /approved/i);
  });

  // ------------------------------------------------------------------ validation
  await check('amount must be a whole number in 1..100000', async () => {
    for (const bad of [100001, 0, -5, 'abc', 5.5, null, 1000000000]) {
      const r = await propose('alice', {
        targetId: ids.Bob, kind: 'award', amount: bad, reason: 'x',
      });
      assert.strictEqual(r.status, 400,
        'amount ' + JSON.stringify(bad) + ' should be rejected, got ' + r.status);
    }
    const ok = await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 100000, reason: 'the cap',
    });
    assert.strictEqual(ok.status, 201, 'exactly 100000 must be allowed');
  });

  await check('reason is required and length capped', async () => {
    for (const bad of ['', '   ', null]) {
      const r = await propose('alice', {
        targetId: ids.Bob, kind: 'award', amount: 5, reason: bad,
      });
      assert.strictEqual(r.status, 400, 'reason ' + JSON.stringify(bad) + ' should be rejected');
    }
    const long = await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 5, reason: 'z'.repeat(281),
    });
    assert.strictEqual(long.status, 400, '281 characters should be rejected');
  });

  await check('kind must be award or deduct', async () => {
    const r = await propose('alice', {
      targetId: ids.Bob, kind: 'steal', amount: 5, reason: 'x',
    });
    assert.strictEqual(r.status, 400);
  });

  await check('DB CHECK blocks an out-of-range amount even if the API is bypassed', async () => {
    const season = (await query('SELECT id FROM seasons WHERE closed_at IS NULL')).rows[0].id;
    await assert.rejects(() => query(
      'INSERT INTO proposals (season_id, proposer_id, target_id, kind, amount, reason) '
      + "VALUES ($1,$2,$3,'award',999999,'bypass')",
      [season, ids.Alice, ids.Bob]));
  });

  await check('DB CHECK blocks self-targeting even if the API is bypassed', async () => {
    const season = (await query('SELECT id FROM seasons WHERE closed_at IS NULL')).rows[0].id;
    await assert.rejects(() => query(
      'INSERT INTO proposals (season_id, proposer_id, target_id, kind, amount, reason) '
      + "VALUES ($1,$2,$2,'award',5,'self')",
      [season, ids.Alice]));
  });

  // ------------------------------------------------------------------ deduct, reject
  await check('deduction with 3 accepts subtracts points', async () => {
    const before = (await pointsOf('alice', 'Frank', 'all')) || 0;
    const p = (await propose('alice', {
      targetId: ids.Frank, kind: 'deduct', amount: 30, reason: 'that outfit',
    })).body.id;
    await vote('bob', p, 'accept');
    await vote('carol', p, 'accept');
    const r = await vote('dave', p, 'accept');
    assert.strictEqual(r.body.status, 'approved');
    assert.strictEqual(await pointsOf('alice', 'Frank', 'all'), before - 30);
  });

  await check('3 rejects kills a proposal and moves nobody total', async () => {
    const before = (await pointsOf('alice', 'Erin', 'all')) || 0;
    const p = (await propose('alice', {
      targetId: ids.Erin, kind: 'award', amount: 999, reason: 'nonsense',
    })).body.id;
    await vote('bob', p, 'reject');
    await vote('carol', p, 'reject');
    const r = await vote('dave', p, 'reject');
    assert.strictEqual(r.body.status, 'rejected');
    assert.strictEqual(await pointsOf('alice', 'Erin', 'all'), before);
  });

  // ------------------------------------------------------------------ the race
  await check('concurrent 3rd and 4th accepts approve exactly once', async () => {
    const before = await pointsOf('alice', 'Bob', 'all');
    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 7, reason: 'race test',
    })).body.id;
    await vote('carol', p, 'accept');
    await vote('dave', p, 'accept');
    // Deciding vote and one more, simultaneously.
    await Promise.all([vote('erin', p, 'accept'), vote('frank', p, 'accept')]);

    const { rows } = await query('SELECT status FROM proposals WHERE id = $1', [p]);
    assert.strictEqual(rows[0].status, 'approved');
    assert.strictEqual(await pointsOf('alice', 'Bob', 'all'), before + 7,
      'points must move by 7 exactly once, not twice');
  });

  // ------------------------------------------------------------------ time windows
  await check('backdating leaves the week but stays in the year', async () => {
    const week = await pointsOf('alice', 'Bob', 'week');
    const year = await pointsOf('alice', 'Bob', 'year');
    await query(
      "UPDATE proposals SET resolved_at = now() - interval '10 days' WHERE id = $1",
      [bobProposal]);
    assert.strictEqual(await pointsOf('alice', 'Bob', 'week'), week - 50, 'must leave the week');
    assert.strictEqual(await pointsOf('alice', 'Bob', 'year'), year, 'must stay in the year');
  });

  await check('everyone appears on the board even on zero', async () => {
    assert.strictEqual((await board('alice', 'week')).length, 6, 'all 6 members listed');
  });

  await check('an invalid window is rejected', async () => {
    assert.strictEqual((await call('alice', '/leaderboard?window=decade')).status, 400);
  });

  // ------------------------------------------------------------------ expiry
  await check('an expired proposal disappears and cannot be voted on', async () => {
    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 5, reason: 'will expire',
    })).body.id;
    await query("UPDATE proposals SET expires_at = now() - interval '1 hour' WHERE id = $1", [p]);
    const r = await vote('carol', p, 'accept');
    assert.strictEqual(r.status, 409, 'expected 409, got ' + r.status);
    const open = (await call('alice', '/proposals?status=open')).body.proposals;
    assert.ok(!open.some((x) => x.id === p), 'expired proposal must not be listed as open');
  });

  // ------------------------------------------------------------------ auth
  await check('no cookie means 401', async () => {
    const r = await fetch(base + '/api/proposals');
    assert.strictEqual(r.status, 401);
  });

  await check('a tampered cookie signature means 401', async () => {
    const tampered = jars.alice.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const r = await fetch(base + '/api/proposals', { headers: { Cookie: tampered } });
    assert.strictEqual(r.status, 401, 'tampered signature must not authenticate');
  });

  await check('login fails identically for wrong password and unknown user', async () => {
    const wrong = await call('tmp', '/auth/login', {
      method: 'POST', body: { username: 'alice', password: 'nope' },
    });
    assert.strictEqual(wrong.status, 401);
    const missing = await call('tmp', '/auth/login', {
      method: 'POST', body: { username: 'nobody', password: 'nope' },
    });
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(wrong.body.error, missing.body.error,
      'must not reveal whether the username exists');
  });

  await check('passwords are bcrypt hashed and never returned by the API', async () => {
    const { rows } = await query('SELECT password_hash FROM users');
    for (const r of rows) assert.match(r.password_hash, /^\$2[aby]\$/, 'not a bcrypt hash');
    const session = JSON.stringify((await call('alice', '/auth/session')).body);
    const me = JSON.stringify((await call('alice', '/me')).body);
    for (const payload of [session, me]) {
      assert.ok(!/password/i.test(payload), 'API leaked a password field');
      assert.ok(!/\$2[aby]\$/.test(payload), 'API leaked a hash');
    }
  });

  await check('signup needs the right invite code and a free username', async () => {
    const bad = await call('new', '/auth/signup', {
      method: 'POST',
      body: { inviteCode: 'wrong', username: 'greg', displayName: 'Greg', password: 'test' },
    });
    assert.strictEqual(bad.status, 403);

    const ok = await call('new', '/auth/signup', {
      method: 'POST',
      body: {
        inviteCode: process.env.INVITE_CODE, username: 'greg',
        displayName: 'Greg', password: 'test',
      },
    });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));

    const dupe = await call('new2', '/auth/signup', {
      method: 'POST',
      body: {
        inviteCode: process.env.INVITE_CODE, username: 'GREG',
        displayName: 'Greg2', password: 'test',
      },
    });
    assert.strictEqual(dupe.status, 409, 'usernames must be case-insensitively unique');
  });

  await check('the invite code tolerates case and stray whitespace', async () => {
    // Phone keyboards capitalise the first letter of a field, which used to lock
    // people out of signup entirely.
    const code = process.env.INVITE_CODE;
    const variants = [code.toUpperCase(), '  ' + code + '  ', code.toLowerCase()];
    for (let i = 0; i < variants.length; i++) {
      const r = await call('v' + i, '/auth/signup', {
        method: 'POST',
        body: {
          inviteCode: variants[i], username: 'variant' + i,
          displayName: 'V' + i, password: 'test',
        },
      });
      assert.strictEqual(r.status, 201,
        'invite code ' + JSON.stringify(variants[i]) + ' should be accepted, got ' + r.status);
    }
    const wrong = await call('vx', '/auth/signup', {
      method: 'POST',
      body: {
        inviteCode: code + 'x', username: 'variantx',
        displayName: 'VX', password: 'test',
      },
    });
    assert.strictEqual(wrong.status, 403, 'a genuinely wrong code must still be refused');
  });

  await check('bad usernames and short passwords are refused at signup', async () => {
    for (const username of ['ab', 'has space', 'UPPER!', 'x'.repeat(21)]) {
      const r = await call('n', '/auth/signup', {
        method: 'POST',
        body: {
          inviteCode: process.env.INVITE_CODE, username,
          displayName: 'X', password: 'test',
        },
      });
      assert.strictEqual(r.status, 400, 'username ' + JSON.stringify(username) + ' should fail');
    }
    const short = await call('n', '/auth/signup', {
      method: 'POST',
      body: {
        inviteCode: process.env.INVITE_CODE, username: 'validname',
        displayName: 'X', password: 'ab',
      },
    });
    assert.strictEqual(short.status, 400, 'a 2-character password should fail');
  });

  // ------------------------------------------------------------------ account screen
  await check('profile edits and password changes work', async () => {
    let r = await call('bob', '/me', {
      method: 'PATCH', body: { displayName: 'Bobby', avatarEmoji: '🐼' },
    });
    assert.strictEqual(r.status, 200);
    assert.ok((await board('alice', 'all')).some((s) => s.display_name === 'Bobby'),
      'a rename must show on the leaderboard');

    r = await call('bob', '/me/password', {
      method: 'POST', body: { currentPassword: 'wrong', newPassword: 'newpass' },
    });
    assert.strictEqual(r.status, 403, 'a wrong current password must be refused');

    r = await call('bob', '/me/password', {
      method: 'POST', body: { currentPassword: 'test', newPassword: 'newpass' },
    });
    assert.strictEqual(r.status, 200);

    assert.strictEqual((await call('x', '/auth/login', {
      method: 'POST', body: { username: 'bob', password: 'test' },
    })).status, 401, 'the old password must stop working');
    assert.strictEqual((await call('x', '/auth/login', {
      method: 'POST', body: { username: 'bob', password: 'newpass' },
    })).status, 200, 'the new password must work');
  });

  await check('logout clears the session', async () => {
    await call('erin', '/auth/logout', { method: 'POST' });
    jars.erin = '';
    assert.strictEqual((await call('erin', '/proposals')).status, 401);
    await login('erin');
  });

  // ------------------------------------------------------------------ admin, season close
  await check('non-admins are refused admin endpoints', async () => {
    assert.strictEqual((await call('carol', '/admin/members')).status, 403);
    assert.strictEqual((await call('carol', '/admin/close-season', {
      method: 'POST', body: { confirm: '2026' },
    })).status, 403);
    assert.strictEqual((await call('carol', '/admin/export')).status, 403);
  });

  await check('close-season archives, zeroes the board and deletes nothing', async () => {
    const proposalsBefore = await countRows('SELECT count(*)::int c FROM proposals');
    const season = (await query(
      'SELECT name FROM seasons WHERE closed_at IS NULL')).rows[0].name;

    const wrong = await call('alice', '/admin/close-season', {
      method: 'POST', body: { confirm: 'nope' },
    });
    assert.strictEqual(wrong.status, 400, 'must require the season name to confirm');

    const r = await call('alice', '/admin/close-season', {
      method: 'POST', body: { confirm: season },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.closed, season);

    const standings = await board('alice', 'all');
    assert.ok(standings.every((s) => s.points === 0), 'every total must read 0 in the new season');

    assert.ok(await countRows('SELECT count(*)::int c FROM season_standings') > 0,
      'standings must be archived');
    assert.strictEqual(await countRows('SELECT count(*)::int c FROM proposals'), proposalsBefore,
      'no proposal may be deleted');
    assert.strictEqual(
      await countRows("SELECT count(*)::int c FROM proposals WHERE status = 'open'"), 0,
      'open proposals must be retired by the close');

    const { rows: archived } = await query(
      'SELECT rank, display_name, total FROM season_standings WHERE season_id = '
      + '(SELECT id FROM seasons WHERE name = $1) ORDER BY rank', [season]);
    assert.ok(archived.length > 0, 'the closed season must have frozen standings');
    assert.strictEqual(archived[0].rank, 1, 'the archive must be ranked');
  });

  await check('a new proposal after the close lands in the new season', async () => {
    const p = (await propose('alice', {
      targetId: ids.Carol, kind: 'award', amount: 11, reason: 'new season',
    })).body.id;
    await vote('dave', p, 'accept');
    await vote('erin', p, 'accept');
    await vote('frank', p, 'accept');
    assert.strictEqual(await pointsOf('alice', 'Carol', 'all'), 11,
      'only the new season may count');
  });

  // ------------------------------------------------------------------ new features
  await check('whoever claims the owner username becomes admin automatically', async () => {
    const r = await call('owner', '/auth/signup', {
      method: 'POST',
      body: {
        inviteCode: process.env.INVITE_CODE, username: 'nick',
        displayName: 'Nick', password: 'test',
      },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.user.is_admin, true, 'nick must be admin on signup');
    assert.strictEqual((await call('owner', '/admin/members')).status, 200,
      'and must actually reach admin endpoints');
  });

  await check('admin can change another member display name and username', async () => {
    const { members } = (await call('owner', '/admin/members')).body;
    const dave = members.find((m) => m.username === 'dave');

    const r = await call('owner', '/admin/users/' + dave.id, {
      method: 'PATCH', body: { displayName: 'Big Dave', username: 'bigdave' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.user.display_name, 'Big Dave');
    assert.strictEqual(r.body.user.username, 'bigdave');

    assert.ok((await board('alice', 'all')).some((s) => s.display_name === 'Big Dave'),
      'the rename must show on the leaderboard');
    assert.strictEqual((await call('z', '/auth/login', {
      method: 'POST', body: { username: 'bigdave', password: 'test' },
    })).status, 200, 'the new username must log in');
    assert.strictEqual((await call('z2', '/auth/login', {
      method: 'POST', body: { username: 'dave', password: 'test' },
    })).status, 401, 'the old username must stop working');

    // Later tests vote as this person, so give the new name its own session.
    await login('bigdave');
  });

  await check('admin cannot take a username that is already in use', async () => {
    const { members } = (await call('owner', '/admin/members')).body;
    const carol = members.find((m) => m.username === 'carol');
    const r = await call('owner', '/admin/users/' + carol.id, {
      method: 'PATCH', body: { username: 'alice' },
    });
    assert.strictEqual(r.status, 409, 'expected 409, got ' + r.status);
  });

  await check('non-admins cannot edit anyone', async () => {
    const { members } = (await call('owner', '/admin/members')).body;
    const r = await call('carol', '/admin/users/' + members[0].id, {
      method: 'PATCH', body: { displayName: 'Hacked' },
    });
    assert.strictEqual(r.status, 403);
  });

  await check('reversing an approved transaction takes the points back off', async () => {
    const p = (await propose('alice', {
      targetId: ids.Frank, kind: 'award', amount: 250, reason: 'to be undone',
    })).body.id;
    await vote('carol', p, 'accept');
    await vote('erin', p, 'accept');
    const approved = await vote('bigdave', p, 'accept');
    assert.strictEqual(approved.body.status, 'approved');

    const before = await pointsOf('alice', 'Frank', 'all');

    const noReason = await call('owner', '/admin/proposals/' + p + '/reverse', {
      method: 'POST', body: { reason: '  ' },
    });
    assert.strictEqual(noReason.status, 400, 'a reason must be required');

    const r = await call('owner', '/admin/proposals/' + p + '/reverse', {
      method: 'POST', body: { reason: 'awarded by mistake' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(await pointsOf('alice', 'Frank', 'all'), before - 250,
      'the points must come back off');

    // Reversed, not deleted.
    const { rows } = await query(
      'SELECT status, reverse_reason FROM proposals WHERE id = $1', [p]);
    assert.strictEqual(rows[0].status, 'reversed');
    assert.strictEqual(rows[0].reverse_reason, 'awarded by mistake');

    const again = await call('owner', '/admin/proposals/' + p + '/reverse', {
      method: 'POST', body: { reason: 'twice' },
    });
    assert.strictEqual(again.status, 409, 'must not reverse the same thing twice');
  });

  await check('only approved proposals can be reversed', async () => {
    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 5, reason: 'still open',
    })).body.id;
    const r = await call('owner', '/admin/proposals/' + p + '/reverse', {
      method: 'POST', body: { reason: 'nope' },
    });
    assert.strictEqual(r.status, 409);
  });

  await check('non-admins cannot reverse anything', async () => {
    const { entries } = (await call('owner', '/admin/ledger')).body;
    const approved = entries.find((e) => e.status === 'approved');
    const r = await call('carol', '/admin/proposals/' + approved.id + '/reverse', {
      method: 'POST', body: { reason: 'let me' },
    });
    assert.strictEqual(r.status, 403);
  });

  await check('a proposer can cancel their own open proposal', async () => {
    // Deliberately a non-admin: an admin takes the permanent-delete path instead.
    const p = (await propose('carol', {
      targetId: ids.Bob, kind: 'award', amount: 8, reason: 'changed my mind',
    })).body.id;

    const r = await call('carol', '/proposals/' + p, { method: 'DELETE' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.cancelled, true);

    // Cancelled, not deleted: gone from voting, still on the record.
    const { rows } = await query('SELECT status FROM proposals WHERE id = $1', [p]);
    assert.strictEqual(rows[0].status, 'cancelled');

    const open = (await call('alice', '/proposals?status=open')).body.proposals;
    assert.ok(!open.some((x) => x.id === p), 'a cancelled proposal must leave the vote list');

    assert.strictEqual((await vote('erin', p, 'accept')).status, 409,
      'and must not be votable');
  });

  await check('you cannot cancel someone else proposal or one already settled', async () => {
    const p = (await propose('carol', {
      targetId: ids.Bob, kind: 'award', amount: 9, reason: 'not yours',
    })).body.id;
    assert.strictEqual((await call('erin', '/proposals/' + p, { method: 'DELETE' })).status, 403,
      'a non-proposer non-admin must be refused');

    await vote('alice', p, 'accept');
    await vote('erin', p, 'accept');
    await vote('bigdave', p, 'accept');
    const late = await call('carol', '/proposals/' + p, { method: 'DELETE' });
    assert.strictEqual(late.status, 409, 'cancelling after it passed must be refused');
  });

  await check('an admin can delete any proposal permanently', async () => {
    const p = (await propose('carol', {
      targetId: ids.Bob, kind: 'deduct', amount: 100000, reason: 'junk',
    })).body.id;
    await vote('alice', p, 'accept');

    const r = await call('owner', '/proposals/' + p, { method: 'DELETE' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.deleted, true);
    assert.strictEqual(r.body.pointsChanged, 0, 'it was never approved, so no points moved');

    const { rows } = await query('SELECT id FROM proposals WHERE id = $1', [p]);
    assert.strictEqual(rows.length, 0, 'the row must be gone');
    const { rows: votes } = await query('SELECT * FROM votes WHERE proposal_id = $1', [p]);
    assert.strictEqual(votes.length, 0, 'its votes must go with it');
  });

  await check('deleting an approved proposal reports the points it moved', async () => {
    const before = await pointsOf('alice', 'Carol', 'all');
    const p = (await propose('alice', {
      targetId: ids.Carol, kind: 'award', amount: 40, reason: 'to be deleted',
    })).body.id;
    await vote('bigdave', p, 'accept');
    await vote('erin', p, 'accept');
    await vote('frank', p, 'accept');
    assert.strictEqual(await pointsOf('alice', 'Carol', 'all'), before + 40);

    const r = await call('owner', '/proposals/' + p, { method: 'DELETE' });
    assert.strictEqual(r.body.pointsChanged, -40,
      'deleting an approved award must report the swing it caused');
    assert.strictEqual(await pointsOf('alice', 'Carol', 'all'), before,
      'and the points must actually come off');
  });

  await check('deleting a member reports its impact before doing it', async () => {
    const { members } = (await call('owner', '/admin/members')).body;
    const erin = members.find((m) => m.username === 'erin');

    const r = await call('owner', '/admin/users/' + erin.id + '/impact');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    for (const key of ['as_target', 'as_proposer', 'votes_cast', 'own_points', 'affectsOthers']) {
      assert.ok(key in r.body.impact, 'impact missing ' + key);
    }
    // Nothing destroyed by asking.
    assert.ok((await query('SELECT id FROM users WHERE id = $1', [erin.id])).rows.length === 1);
  });

  await check('deleting a member needs the username typed, and cleans up after itself', async () => {
    // A disposable member, so removing them cannot disturb the rest of the suite.
    const signup = await call('doomed', '/auth/signup', {
      method: 'POST',
      body: {
        inviteCode: process.env.INVITE_CODE, username: 'doomed',
        displayName: 'Doomed', password: 'test',
      },
    });
    assert.strictEqual(signup.status, 201, JSON.stringify(signup.body));
    const victim = { id: signup.body.user.id };

    // Give them something to clean up: points received, a proposal they made, a vote.
    const received = (await propose('alice', {
      targetId: victim.id, kind: 'award', amount: 33, reason: 'about to vanish',
    })).body.id;
    await vote('carol', received, 'accept');
    await vote('erin', received, 'accept');
    await vote('bigdave', received, 'accept');

    const theirs = (await propose('doomed', {
      targetId: ids.Bob, kind: 'award', amount: 21, reason: 'their proposal',
    })).body.id;
    await vote('carol', theirs, 'accept');
    await vote('erin', theirs, 'accept');
    await vote('bigdave', theirs, 'accept');

    const bobBefore = await pointsOf('alice', 'Bobby', 'all');

    // The impact preview must name Bob, whose points only exist because of them.
    const { impact } = (await call('owner', '/admin/users/' + victim.id + '/impact')).body;
    assert.strictEqual(impact.own_points, 33);
    assert.ok(impact.affectsOthers.some((a) => a.display_name === 'Bobby' && a.delta === 21),
      'must warn that Bobby loses the 21 they proposed');

    const noConfirm = await call('owner', '/admin/users/' + victim.id, {
      method: 'DELETE', body: { confirm: 'wrong' },
    });
    assert.strictEqual(noConfirm.status, 400, 'must require the username to confirm');

    const r = await call('owner', '/admin/users/' + victim.id, {
      method: 'DELETE', body: { confirm: 'doomed' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    assert.strictEqual(await pointsOf('alice', 'Bobby', 'all'), bobBefore - 21,
      'and Bobby must actually lose them');
    void theirs;

    // Nothing may be left pointing at a member who no longer exists.
    assert.strictEqual(
      await countRows('SELECT count(*)::int c FROM users WHERE id = $1', [victim.id]), 0);
    assert.strictEqual(
      await countRows(
        'SELECT count(*)::int c FROM proposals WHERE proposer_id = $1 OR target_id = $1',
        [victim.id]), 0, 'their proposals must go');
    assert.strictEqual(
      await countRows('SELECT count(*)::int c FROM votes WHERE voter_id = $1', [victim.id]),
      0, 'their votes must go');
    assert.strictEqual(
      await countRows('SELECT count(*)::int c FROM season_standings WHERE user_id = $1',
        [victim.id]), 0, 'their archived standings must go');

    // And the leaderboard no longer lists them.
    assert.ok(!(await board('alice', 'all')).some((s) => s.display_name === 'Doomed'),
      'a deleted member must leave the leaderboard');
  });

  await check('you cannot delete yourself or the last admin', async () => {
    const { members } = (await call('owner', '/admin/members')).body;
    const me = members.find((m) => m.username === 'nick');

    const self = await call('owner', '/admin/users/' + me.id, {
      method: 'DELETE', body: { confirm: 'nick' },
    });
    assert.strictEqual(self.status, 400, 'deleting yourself must be refused');

    // alice is the other admin; removing her must be allowed, but then nick is the last
    // one and an attempt on him would be refused for a different reason.
    const admins = members.filter((m) => m.is_admin).length;
    assert.ok(admins >= 2, 'this test assumes more than one admin');
  });

  await check('non-admins cannot delete members', async () => {
    const { members } = (await call('owner', '/admin/members')).body;
    const anyone = members.find((m) => m.username === 'bob');
    const r = await call('carol', '/admin/users/' + anyone.id, {
      method: 'DELETE', body: { confirm: 'bob' },
    });
    assert.strictEqual(r.status, 403);
  });

  await check('the admin open list shows only what is still open', async () => {
    const r = await call('owner', '/admin/open');
    assert.strictEqual(r.status, 200);
    for (const p of r.body.proposals) {
      const { rows } = await query('SELECT status FROM proposals WHERE id = $1', [p.id]);
      assert.strictEqual(rows[0].status, 'open', 'only open proposals may be listed');
    }
    assert.strictEqual((await call('carol', '/admin/open')).status, 403,
      'non-admins must not see it');
  });

  await check('the current period reports a Sunday-midnight week boundary', async () => {
    const r = await call('alice', '/seasons/current');
    assert.strictEqual(r.status, 200);
    const { week, month, year, timezone } = r.body;
    assert.ok(week.number >= 1, 'week number must be 1 or more');

    const tz = timezone;
    const endsAt = new Date(week.endsAt);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(endsAt);
    const get = (t) => local.find((p) => p.type === t).value;
    assert.strictEqual(get('weekday'), 'Sun', 'the week must end on a Sunday');
    assert.strictEqual(Number(get('hour')) % 24, 0, 'at 12:00 AM');
    assert.strictEqual(Number(get('minute')), 0, 'on the hour');

    assert.ok(new Date(week.endsAt) > new Date(), 'the week end must be in the future');
    assert.ok(new Date(month.endsAt) > new Date(), 'the month end must be in the future');
    assert.ok(year.name.match(/^\d{4}$/), 'the year needs a name');
  });

  await check('an invalid APP_TZ falls back instead of taking the site down', async () => {
    // A typo in the Vercel config box used to 500 every page that touched a date.
    const P = require('../src/periods');
    const real = process.env.APP_TZ;
    for (const bad of ['Toronto Canada', 'Toronto', 'Canada/Toronto', 'not a zone', '']) {
      process.env.APP_TZ = bad;
      delete require.cache[require.resolve('../src/periods')];
      const fresh = require('../src/periods');
      const resolved = fresh.tz();
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: resolved })
        .format(new Date()), 'fallback for ' + JSON.stringify(bad) + ' must be usable');
      assert.doesNotThrow(() => fresh.describeNow(new Date()),
        'period maths must survive ' + JSON.stringify(bad));
    }
    process.env.APP_TZ = real;
    delete require.cache[require.resolve('../src/periods')];
    require('../src/periods');
    void P;
  });

  await check('the hall of fame reports week, month and year winners', async () => {
    const r = await call('alice', '/seasons');
    assert.strictEqual(r.status, 200);
    for (const key of ['weeks', 'months', 'years', 'current', 'timezone']) {
      assert.ok(key in r.body, 'hall of fame missing ' + key);
    }
    assert.ok(Array.isArray(r.body.weeks), 'weeks must be a list');

    // The period in progress must never be declared won.
    const currentWeekStart = new Date(r.body.current.week.startsAt).getTime();
    for (const w of r.body.weeks) {
      assert.ok(new Date(w.startsAt).getTime() < currentWeekStart,
        'an unfinished week must not appear as a winner');
    }
  });

  await check('a finished week produces a winner labelled Week N', async () => {
    // A real season starts on Jan 1, so weeks are numbered from there. Move the season
    // start back to match, otherwise a backdated award lands before the season began.
    await query(
      "UPDATE seasons SET started_at = date_trunc('year', now()) WHERE closed_at IS NULL");

    // Backdate an approved award into a previous week.
    const p = (await propose('alice', {
      targetId: ids.Erin, kind: 'award', amount: 4242, reason: 'last week hero',
    })).body.id;
    await vote('carol', p, 'accept');
    await vote('bigdave', p, 'accept');
    await vote('frank', p, 'accept');
    await query(
      "UPDATE proposals SET resolved_at = now() - interval '10 days' WHERE id = $1", [p]);

    const { weeks } = (await call('alice', '/seasons')).body;
    const win = weeks.find((w) => w.display_name === 'Erin' && w.total >= 4242);
    assert.ok(win, 'Erin should be G of the Week for the backdated week');
    assert.match(win.label, /^Week \d+$/, 'label must read "Week N", got ' + win.label);
  });

  await check('reversed points do not count toward anything', async () => {
    // An earlier test renamed bob to Bobby, so look him up by what he is called now.
    const name = (await call('owner', '/admin/members')).body.members
      .find((m) => m.username === 'bob').display_name;

    const before = await pointsOf('alice', name, 'all');
    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 999, reason: 'will be undone',
    })).body.id;
    await vote('carol', p, 'accept');
    await vote('erin', p, 'accept');
    await vote('bigdave', p, 'accept');
    assert.strictEqual(await pointsOf('alice', name, 'all'), before + 999);

    await call('owner', '/admin/proposals/' + p + '/reverse', {
      method: 'POST', body: { reason: 'undo' },
    });
    assert.strictEqual(await pointsOf('alice', name, 'all'), before,
      'reversal must restore the previous total exactly');
  });

  await check('the login page no longer carries the old joke text', async () => {
    const html = await (await fetch(base + '/login')).text();
    assert.ok(!/NICK WILL SEE ALL/i.test(html), 'the banner must be gone');
    assert.ok(!/DO NOT WRITE YOUR ACTUAL PASSWORD/i.test(html), 'the warning must be gone');
    assert.ok(!/Argue about them/i.test(html), 'the subtitle must be gone');
    assert.ok(!/<h1>\s*G Points\s*<\/h1>/i.test(html), 'the heading must be gone');
    assert.ok(/Invite code/i.test(html), 'but the signup form must still be there');
  });

  await check('the export carries the standings and every proposal', async () => {
    const res = await fetch(base + '/api/admin/export', { headers: { Cookie: jars.alice } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
    const dump = JSON.parse(await res.text());
    for (const key of ['season', 'standings', 'users', 'proposals', 'votes']) {
      assert.ok(key in dump, 'export missing ' + key);
    }
  });

  await check('discord notifications cannot ping the server or break voting', async () => {
    const discord = require('../src/discord');
    const realFetch = global.fetch;
    const sent = [];

    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/token';
    global.fetch = async (_url, opts) => {
      sent.push(JSON.parse(opts.body));
      return { ok: true, status: 204 };
    };

    await discord.proposalOpened({
      kind: 'award', amount: 5, reason: '@everyone @here **bold** `code`',
      proposerName: 'A', targetName: 'B', votesRequired: 3,
    });

    assert.deepStrictEqual(sent[0].allowed_mentions, { parse: [] },
      'mentions must be suppressed or a reason could ping the whole server');
    const body = sent[0].embeds[0].description;
    assert.ok(body.includes('\\*\\*'), 'markdown in user text must be escaped');

    // A Discord outage must never fail the request that already succeeded.
    global.fetch = () => Promise.reject(new Error('discord is down'));
    const outage = await discord.proposalOpened({
      kind: 'award', amount: 1, reason: 'x',
      proposerName: 'A', targetName: 'B', votesRequired: 3,
    });
    assert.strictEqual(outage.ok, false, 'an outage is reported, not thrown');

    // With no webhook set, nothing is attempted at all.
    delete process.env.DISCORD_WEBHOOK_URL;
    global.fetch = () => { throw new Error('should not have been called'); };
    const off = await discord.proposalOpened({
      kind: 'award', amount: 1, reason: 'x',
      proposerName: 'A', targetName: 'B', votesRequired: 3,
    });
    assert.ok(off.skipped, 'unconfigured discord must be a no-op');

    global.fetch = realFetch;
  });

  await check('discord is notified BEFORE the response, not after', async () => {
    // On Vercel the function stops executing the moment a response is sent, so a
    // notification fired afterwards is aborted mid-flight and never arrives. The only
    // way to be sure it went is that the webhook completed before the client saw 201.
    const realFetch = global.fetch;
    let webhookDone = false;
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/token';
    global.fetch = async (url, opts) => {
      if (String(url).includes('discord.com')) {
        await new Promise((r) => setTimeout(r, 60));
        webhookDone = true;
        return { ok: true, status: 204 };
      }
      return realFetch(url, opts);
    };

    const r = await propose('alice', {
      targetId: ids.Carol, kind: 'award', amount: 3, reason: 'ordering check',
    });
    assert.strictEqual(r.status, 201);
    assert.ok(webhookDone,
      'the webhook must have completed before the response was returned');

    delete process.env.DISCORD_WEBHOOK_URL;
    global.fetch = realFetch;
  });

  await check('voting still works when discord is broken', async () => {
    const realFetch = global.fetch;
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/token';
    global.fetch = (url, opts) =>
      String(url).includes('discord.com')
        ? Promise.reject(new Error('discord is down'))
        : realFetch(url, opts);

    const p = (await propose('alice', {
      targetId: ids.Carol, kind: 'award', amount: 12, reason: 'discord is down',
    })).body.id;
    assert.ok(p, 'proposing must work with discord broken');

    await vote('bigdave', p, 'accept');
    await vote('erin', p, 'accept');
    const r = await vote('frank', p, 'accept');
    assert.strictEqual(r.body.status, 'approved',
      'the deciding vote must still land when the webhook fails');

    delete process.env.DISCORD_WEBHOOK_URL;
    global.fetch = realFetch;
  });

  // ------------------------------------------------------- voting from Discord
  //
  // The interactions endpoint is public — Discord calls it, so anyone can. Its only
  // defence is the Ed25519 signature, which makes these the most important tests here.
  await check('an unsigned or wrongly signed interaction is rejected', async () => {
    const nacl = require('node:crypto');
    const { publicKey, privateKey } = nacl.generateKeyPairSync('ed25519');
    const pubHex = publicKey.export({ type: 'spki', format: 'der' })
      .subarray(12).toString('hex');
    process.env.DISCORD_PUBLIC_KEY = pubHex;

    const body = JSON.stringify({ type: 1 });

    // No signature at all.
    const bare = await fetch(base + '/api/discord/interactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.strictEqual(bare.status, 401, 'an unsigned interaction must be refused');

    // Signature from the wrong key.
    const wrongKey = nacl.generateKeyPairSync('ed25519').privateKey;
    const ts = String(Math.floor(Date.now() / 1000));
    const forged = nacl.sign(null, Buffer.from(ts + body), wrongKey).toString('hex');
    const bad = await fetch(base + '/api/discord/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Ed25519': forged,
        'X-Signature-Timestamp': ts,
      },
      body,
    });
    assert.strictEqual(bad.status, 401, 'a forged signature must be refused');

    // Correctly signed PING must be PONGed, or Discord will not accept the endpoint.
    const good = nacl.sign(null, Buffer.from(ts + body), privateKey).toString('hex');
    const ok = await fetch(base + '/api/discord/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Ed25519': good,
        'X-Signature-Timestamp': ts,
      },
      body,
    });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(await ok.json(), { type: 1 }, 'a PING must be PONGed');

    signIt = (payload) => {
      const raw = JSON.stringify(payload);
      const stamp = String(Math.floor(Date.now() / 1000));
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Ed25519': nacl.sign(null, Buffer.from(stamp + raw), privateKey).toString('hex'),
          'X-Signature-Timestamp': stamp,
        },
        body: raw,
      };
    };
  });

  await check('an unlinked Discord user is given a link code, not a vote', async () => {
    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 14, reason: 'from discord',
    })).body.id;

    const res = await fetch(base + '/api/discord/interactions', signIt({
      type: 3,
      data: { custom_id: `vote:${p}:accept` },
      member: { user: { id: '999000111222' } },
    }));
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.match(body.data.content, /not linked/i, 'must explain the account is unlinked');
    assert.strictEqual(body.data.flags, 64, 'and say so privately');

    const { rows } = await query(
      'SELECT code FROM discord_link_codes WHERE discord_id = $1', ['999000111222']);
    assert.ok(rows[0]?.code, 'a code must have been issued');
    assert.ok(body.data.content.includes(rows[0].code), 'and shown to the user');

    // No vote was recorded for an unknown person.
    const votes = await query('SELECT count(*)::int c FROM votes WHERE proposal_id = $1', [p]);
    assert.strictEqual(votes.rows[0].c, 0, 'an unlinked click must not count as a vote');

    discordProposal = p;
  });

  await check('claiming the code links the account, and then Discord votes count', async () => {
    const { rows } = await query(
      'SELECT code FROM discord_link_codes WHERE discord_id = $1', ['999000111222']);

    const wrong = await call('carol', '/me/link-discord', {
      method: 'POST', body: { code: 'NOPE99' },
    });
    assert.strictEqual(wrong.status, 404, 'a bad code must be refused');

    const linked = await call('carol', '/me/link-discord', {
      method: 'POST', body: { code: rows[0].code },
    });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.body));

    // The code is single use.
    const reuse = await call('erin', '/me/link-discord', {
      method: 'POST', body: { code: rows[0].code },
    });
    assert.strictEqual(reuse.status, 404, 'a claimed code must not work twice');

    // Now the same Discord click counts as Carol.
    const res = await fetch(base + '/api/discord/interactions', signIt({
      type: 3,
      data: { custom_id: `vote:${discordProposal}:accept` },
      member: { user: { id: '999000111222' } },
    }));
    const body = await res.json();
    assert.strictEqual(body.type, 7, 'the message should be updated in place');

    const votes = await query(
      `SELECT u.username FROM votes v JOIN users u ON u.id = v.voter_id
       WHERE v.proposal_id = $1`, [discordProposal]);
    assert.strictEqual(votes.rows.length, 1);
    assert.strictEqual(votes.rows[0].username, 'carol',
      'the vote must be attributed to the linked account');
  });

  await check('Discord votes obey the same rules as app votes', async () => {
    // Carol already voted above; clicking again must be refused, not double-counted.
    const again = await fetch(base + '/api/discord/interactions', signIt({
      type: 3,
      data: { custom_id: `vote:${discordProposal}:accept` },
      member: { user: { id: '999000111222' } },
    }));
    const body = await again.json();
    assert.match(body.data?.content || '', /already voted/i);

    const votes = await query(
      'SELECT count(*)::int c FROM votes WHERE proposal_id = $1', [discordProposal]);
    assert.strictEqual(votes.rows[0].c, 1, 'still exactly one vote');

    // And the proposer cannot vote from Discord either.
    await query('UPDATE users SET discord_id = $1 WHERE username = $2',
      ['555000111222', 'alice']);
    const asProposer = await fetch(base + '/api/discord/interactions', signIt({
      type: 3,
      data: { custom_id: `vote:${discordProposal}:accept` },
      member: { user: { id: '555000111222' } },
    }));
    assert.match((await asProposer.json()).data.content, /proposed this/i);
  });

  await check('/propose autocomplete offers G Points members', async () => {
    const res = await fetch(base + '/api/discord/interactions', signIt({
      type: 4,
      data: { name: 'propose', options: [{ name: 'user', value: 'car', focused: true }] },
      member: { user: { id: '999000111222' } },
    }));
    const body = await res.json();
    assert.strictEqual(body.type, 8, 'must be an autocomplete result');
    assert.ok(body.data.choices.some((c) => /Carol/i.test(c.name)),
      'typing "car" should offer Carol');
    // The value is an account id, so a duplicated display name cannot be ambiguous.
    assert.match(body.data.choices[0].value, /^\d+$/, 'choices must carry the user id');
  });

  await check('/propose posts to the G Points channel, wherever it was typed', async () => {
    const posted = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('discord.com/api/')) {
        posted.push({ url: String(url), body: JSON.parse(opts.body) });
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: '555999' }) };
      }
      return realFetch(url, opts);
    };

    // Configured G Points channel, deliberately different from where the command is typed.
    process.env.DISCORD_CHANNEL_ID = '111222333';

    const before = await countRows('SELECT count(*)::int c FROM proposals');
    const res = await fetch(base + '/api/discord/interactions', signIt({
      type: 2,
      channel_id: '777888999', // typed somewhere else entirely
      guild_id: '1360419275528994916',
      data: {
        name: 'propose',
        options: [
          { name: 'user', value: String(ids.Bob) },
          { name: 'type', value: 'award' },
          { name: 'amount', value: 250 },
          { name: 'why', value: 'typed it straight into discord' },
        ],
      },
      member: { user: { id: '999000111222' } }, // carol, linked earlier
    }));
    const body = await res.json();
    global.fetch = realFetch;

    assert.match(body.data.content, /Posted/i, JSON.stringify(body));
    assert.strictEqual(body.data.flags, 64, 'the confirmation should be private');
    assert.strictEqual(await countRows('SELECT count(*)::int c FROM proposals'), before + 1);

    // Lands in the G Points channel, not the one it was typed in.
    assert.ok(posted.some((p) => p.url.includes('/channels/111222333/messages')),
      'must post to the configured G Points channel');
    assert.ok(!posted.some((p) => p.url.includes('/channels/777888999/messages')),
      'must NOT post to the channel it was typed in');

    assert.match(body.data.content, /<#111222333>/,
      'the reply should name the channel it went to');
    assert.match(body.data.content, /discord\.com\/channels\/1360419275528994916\/111222333\//,
      'and include a jump link to the message');

    const message = posted.find((p) => p.url.includes('111222333')).body;
    assert.ok(message.components?.[0]?.components?.length === 2,
      'the posted message must carry the two vote buttons');

    const { rows } = await query(
      `SELECT p.amount, p.reason, p.discord_message_id, p.discord_channel_id,
              pr.username AS proposer
       FROM proposals p JOIN users pr ON pr.id = p.proposer_id
       ORDER BY p.id DESC LIMIT 1`
    );
    assert.strictEqual(rows[0].proposer, 'carol', 'attributed to the linked account');
    assert.strictEqual(rows[0].amount, 250);
    assert.strictEqual(rows[0].discord_message_id, '555999', 'message id stored for editing');
    assert.strictEqual(rows[0].discord_channel_id, '111222333',
      'the stored channel must be where it was actually posted');

    delete process.env.DISCORD_CHANNEL_ID;
  });

  await check('/propose falls back to the current channel if none is configured', async () => {
    const posted = [];
    const realFetch = global.fetch;
    delete process.env.DISCORD_CHANNEL_ID;
    global.fetch = async (url, opts) => {
      if (String(url).includes('discord.com/api/')) {
        posted.push(String(url));
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: '556000' }) };
      }
      return realFetch(url, opts);
    };

    await fetch(base + '/api/discord/interactions', signIt({
      type: 2,
      channel_id: '777888999',
      data: {
        name: 'propose',
        options: [
          { name: 'user', value: String(ids.Bob) },
          { name: 'type', value: 'deduct' },
          { name: 'amount', value: 5 },
          { name: 'why', value: 'no channel configured' },
        ],
      },
      member: { user: { id: '999000111222' } },
    }));
    global.fetch = realFetch;

    // Better to post it in the wrong place than to lose it.
    assert.ok(posted.some((u) => u.includes('/channels/777888999/messages')),
      'with no channel configured it must fall back to where it was typed');
  });

  await check('a proposal that cannot reach Discord is not left stranded', async () => {
    const realFetch = global.fetch;
    process.env.DISCORD_CHANNEL_ID = '111222333';
    // The bot cannot post — wrong channel, missing permission, whatever.
    global.fetch = async (url, opts) => {
      if (String(url).includes('discord.com/api/')) {
        return { ok: false, status: 403, statusText: 'Forbidden', text: async () => '{"code":50013}' };
      }
      return realFetch(url, opts);
    };

    const before = await countRows('SELECT count(*)::int c FROM proposals');
    const res = await fetch(base + '/api/discord/interactions', signIt({
      type: 2, channel_id: '777888999',
      data: {
        name: 'propose',
        options: [
          { name: 'user', value: String(ids.Bob) },
          { name: 'type', value: 'award' },
          { name: 'amount', value: 77 },
          { name: 'why', value: 'will fail to post' },
        ],
      },
      member: { user: { id: '999000111222' } },
    }));
    const body = await res.json();
    global.fetch = realFetch;

    assert.match(body.data.content, /nothing was created/i,
      'must say the proposal was not created');
    assert.strictEqual(await countRows('SELECT count(*)::int c FROM proposals'), before,
      'a proposal that never reached Discord must be rolled back, not stranded');

    delete process.env.DISCORD_CHANNEL_ID;
  });

  await check('/propose enforces the same rules as the app', async () => {
    const send = (options, who = '999000111222') =>
      fetch(base + '/api/discord/interactions', signIt({
        type: 2, channel_id: '777888999',
        data: { name: 'propose', options },
        member: { user: { id: who } },
      })).then((r) => r.json());

    const base_ = [
      { name: 'type', value: 'award' },
      { name: 'amount', value: 10 },
      { name: 'why', value: 'x' },
    ];

    // Carol proposing for Carol.
    const carolId = (await query("SELECT id FROM users WHERE username = 'carol'")).rows[0].id;
    let r = await send([{ name: 'user', value: String(carolId) }, ...base_]);
    assert.match(r.data.content, /yourself/i, 'must refuse proposing for yourself');

    r = await send([
      { name: 'user', value: String(ids.Bob) },
      { name: 'type', value: 'award' },
      { name: 'amount', value: 100001 },
      { name: 'why', value: 'x' },
    ]);
    assert.match(r.data.content, /between 1 and/i, 'must enforce the cap');

    r = await send([
      { name: 'user', value: String(ids.Bob) },
      { name: 'type', value: 'award' },
      { name: 'amount', value: 10 },
      { name: 'why', value: '   ' },
    ]);
    assert.match(r.data.content, /say why/i, 'must require a reason');

    // Someone whose Discord is not linked gets a code, not a proposal.
    r = await send([{ name: 'user', value: String(ids.Bob) }, ...base_], '000111222333');
    assert.match(r.data.content, /link your discord/i, 'unlinked users must be told to link');
  });

  await check('app voting can be switched off once Discord is live', async () => {
    const bot = require('../src/discordBot');

    process.env.APP_VOTING = 'off';
    assert.strictEqual(bot.appVotingEnabled(), false);

    const p = (await propose('alice', {
      targetId: ids.Bob, kind: 'award', amount: 6, reason: 'app voting off',
    })).body.id;
    const blocked = await vote('carol', p, 'accept');
    assert.strictEqual(blocked.status, 403, 'app voting must be refused');
    assert.match(blocked.body.error, /Discord/i, 'and say where to vote instead');

    const list = await call('carol', '/proposals?status=open');
    assert.strictEqual(list.body.appVoting, false,
      'the page must be told so it can hide its buttons');

    process.env.APP_VOTING = 'on';
    assert.strictEqual(bot.appVotingEnabled(), true);
    const allowed = await vote('carol', p, 'accept');
    assert.strictEqual(allowed.status, 200, 'and switching back must restore it');

    delete process.env.APP_VOTING;
  });

  await check('every page is served and clean URLs work', async () => {
    for (const path of ['/', '/login', '/propose', '/pending', '/feed', '/account',
                        '/hall-of-fame', '/admin']) {
      assert.strictEqual((await fetch(base + path)).status, 200, path + ' should serve');
    }
  });

  server.close();
  await pool.end();

  console.log('\n' + results.join('\n'));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTEST HARNESS CRASHED:\n', err);
  process.exit(1);
});
