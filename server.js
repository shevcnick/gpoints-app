// Local development only. Vercel uses api/index.js instead.
const app = require('./src/app');
const { pool, usingPglite } = require('./src/db');

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () =>
  console.log(`G Points running on http://localhost:${PORT}`));

// PGlite writes its data directory from inside WASM. Killed mid-write, that directory
// can be left corrupt and unopenable, so close it properly on the way out.
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} — closing${usingPglite ? ' the database' : ''}…`);
  server.close();
  try {
    await pool.end();
  } catch (err) {
    console.error('database did not close cleanly:', err.message);
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal));
}
