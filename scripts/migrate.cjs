// Applies db/migrate.sql to a database that already has real data in it.
// Unlike db:setup, this drops nothing. Usage: npm run db:migrate
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');

// Read DATABASE_URL even when it is commented out in .env, so the live database can be
// migrated without leaving local dev pointed at production.
function liveUrl() {
  if (process.env.DATABASE_URL && process.env.USE_PGLITE !== '1') return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, 'utf8').match(/^#?\s*DATABASE_URL=(postgres\S+)/m);
  return m ? m[1] : null;
}

(async () => {
  const url = liveUrl();
  if (!url) {
    console.error('No DATABASE_URL found. Nothing to migrate.');
    process.exit(1);
  }

  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const host = (url.match(/@([^/:]+)/) || [])[1];
  console.log('Migrating ' + host);

  const before = await client.query('SELECT count(*)::int AS c FROM users');
  console.log('  users before: ' + before.rows[0].c);

  await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.sql'), 'utf8'));

  const after = await client.query('SELECT count(*)::int AS c FROM users');
  console.log('  users after:  ' + after.rows[0].c);

  if (after.rows[0].c !== before.rows[0].c) {
    console.error('\nUSER COUNT CHANGED — that should never happen in a migration.');
    process.exit(1);
  }

  // Prove the new shape is actually there.
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'proposals'`
  );
  const have = cols.rows.map((r) => r.column_name);
  const missing = ['reversed_at', 'reversed_by', 'reverse_reason'].filter((c) => !have.includes(c));

  const chk = await client.query(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
     WHERE conrelid = 'proposals'::regclass AND contype = 'c'`
  );
  const allowsReversed = chk.rows.some((r) => r.d.includes('status') && r.d.includes('reversed'));

  console.log('  reversal columns: ' + (missing.length ? 'MISSING ' + missing.join(', ') : 'present'));
  console.log("  'reversed' status allowed: " + allowsReversed);

  await client.end();

  if (missing.length || !allowsReversed) {
    console.error('\nMigration did not fully apply.');
    process.exit(1);
  }
  console.log('\nDone. Nothing was deleted.');
  // No process.exit: the client is already closed, and forcing exit while sockets are
  // still closing makes libuv print an assertion failure on Windows.
})().catch((err) => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
