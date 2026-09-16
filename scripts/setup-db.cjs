// Applies db/schema.sql (and db/seed.sql with --seed) to whichever database is configured.
// Usage:  node scripts/setup-db.cjs [--seed]
require('dotenv').config();
const fs = require('node:fs');
const { query, label } = require('../src/db');

(async () => {
  console.log('Target: ' + label);

  await query(fs.readFileSync('db/schema.sql', 'utf8'));
  console.log('  schema applied');

  if (process.argv.includes('--seed')) {
    await query(fs.readFileSync('db/seed.sql', 'utf8'));
    const { rows } = await query('SELECT count(*)::int AS c FROM users');
    console.log('  seeded — ' + rows[0].c + ' users, password "test"');
  }

  const { rows } = await query('SELECT name FROM seasons WHERE closed_at IS NULL');
  console.log('  active season: ' + rows[0].name);
  process.exit(0);
})().catch((err) => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
