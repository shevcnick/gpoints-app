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

async function main() {
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

    const fame = (await call('alice', '/seasons')).body.seasons;
    assert.ok(fame.some((s) => s.name === season),
      'the closed season must appear in the Hall of Fame');
    const champion = fame.find((s) => s.name === season).standings[0];
    assert.strictEqual(champion.rank, 1, 'the archive must be ranked');
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

  await check('the export carries the standings and every proposal', async () => {
    const res = await fetch(base + '/api/admin/export', { headers: { Cookie: jars.alice } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
    const dump = JSON.parse(await res.text());
    for (const key of ['season', 'standings', 'users', 'proposals', 'votes']) {
      assert.ok(key in dump, 'export missing ' + key);
    }
  });

  await check('static pages are served with the banner on the login', async () => {
    const login = await (await fetch(base + '/login')).text();
    assert.match(login, /DO NOT WRITE YOUR ACTUAL PASSWORD/,
      'the banner must be in the served HTML');
    assert.strictEqual((await fetch(base + '/')).status, 200);
    assert.strictEqual((await fetch(base + '/propose')).status, 200, 'clean URLs must work');
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
