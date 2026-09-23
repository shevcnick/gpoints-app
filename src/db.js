// Two drivers behind one interface.
//
//   Production / real local Postgres:  DATABASE_URL is set  -> node-postgres (pg)
//   Zero-setup local demo:             DATABASE_URL absent  -> PGlite, real Postgres
//                                                              compiled to WASM, stored
//                                                              in ./.pglite, no server
//                                                              and no password needed.
//
// Everything above this module only ever sees { query, tx, activeSeason }.

// Sums of points are bigint, because with a billion-point cap a few entries overflow a
// 32-bit integer. node-postgres hands bigint back as a string to avoid losing precision;
// these totals are nowhere near 2^53, so parse them as numbers and keep the arithmetic
// working everywhere downstream.
try {
  require('pg').types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
} catch {
  // pg is not installed in some local setups; PGlite returns numbers already.
}

const USE_PGLITE = !process.env.DATABASE_URL || process.env.USE_PGLITE === '1';

// PGlite is a devDependency and never ships to production. Without this, forgetting to set
// DATABASE_URL in Vercel fails as "Cannot find module @electric-sql/pglite", which says
// nothing about the actual mistake.
if (USE_PGLITE && process.env.NODE_ENV === 'production') {
  throw new Error(
    'DATABASE_URL is not set. In production it must point at your Neon pooled connection '
    + 'string (the host contains "-pooler"). Set it under Settings -> Environment Variables '
    + 'in Vercel, then redeploy.'
  );
}

let backend;

if (USE_PGLITE) {
  const path = require('node:path');
  const dir = process.env.PGLITE_DIR || path.join(__dirname, '..', '.pglite');

  // One instance per process, created lazily on first use.
  let dbPromise;
  const get = () => {
    if (!dbPromise) {
      const { PGlite } = require('@electric-sql/pglite');
      dbPromise = PGlite.create(dir);
    }
    return dbPromise;
  };

  // PGlite runs one statement at a time, so overlapping transactions must queue rather
  // than interleave. Chaining them off a single promise gives the same all-or-nothing
  // guarantee pg gets from a dedicated connection.
  let queue = Promise.resolve();

  backend = {
    async query(text, params) {
      const db = await get();
      // exec() handles multi-statement scripts (schema.sql); query() handles parameters.
      if (params === undefined && /;\s*\S/.test(text.replace(/;\s*$/, ''))) {
        await db.exec(text);
        return { rows: [], rowCount: 0 };
      }
      return db.query(text, params);
    },

    async tx(fn) {
      const db = await get();
      const run = async () => {
        return db.transaction(async (t) => {
          // Present the same shape pg's client has, so route code is driver-agnostic.
          return fn({ query: (text, params) => t.query(text, params) });
        });
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },

    async end() {
      if (dbPromise) await (await dbPromise).close();
    },

    label: 'PGlite (in-process, ./.pglite)',
  };
} else {
  const { Pool } = require('pg');

  // Neon's pooled endpoint (host contains "-pooler") does the real pooling, so a small
  // max here is correct for short-lived serverless invocations.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    ssl: /neon\.tech|render\.com|supabase|amazonaws/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : false,
  });

  backend = {
    query: (text, params) => pool.query(text, params),

    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    end: () => pool.end(),
    label: 'Postgres via DATABASE_URL',
  };
}

const { query, tx, end, label } = backend;

// The single season with closed_at IS NULL. Every leaderboard scopes to it, which is what
// makes closing a season reset everyone to zero without deleting anything.
async function activeSeason(client) {
  const runner = client || { query };
  const { rows } = await runner.query(
    'SELECT * FROM seasons WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1'
  );
  if (!rows[0]) throw new Error('No active season — apply db/schema.sql');
  return rows[0];
}

module.exports = {
  query, tx, activeSeason, label,
  usingPglite: USE_PGLITE,
  // Kept as `pool` so the test script can shut either driver down the same way.
  pool: { end },
};
