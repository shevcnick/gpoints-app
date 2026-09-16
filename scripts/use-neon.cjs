// Paste a Neon connection string in, and this wires it into .env, creates the tables,
// and confirms it works. Usage: npm run use-neon
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const ENV = path.join(__dirname, '..', '.env');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// Never print the password back to the screen.
const redact = (url) => url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:****@');

(async () => {
  console.log('\nPaste your Neon connection string.');
  console.log('Neon console -> your project -> Connect. Turn ON "Pooled connection".');
  console.log('It should look like:');
  console.log('  postgresql://user:password@ep-something-pooler.region.aws.neon.tech/neondb?sslmode=require\n');

  const raw = (await ask('Connection string: ')).trim().replace(/^["']|["']$/g, '');
  rl.close();

  if (!/^postgres(ql)?:\/\/\S+@\S+\/\S+/.test(raw)) {
    console.error('\nThat does not look like a Postgres connection string.');
    console.error('It must start with postgresql:// and contain a host and database name.');
    process.exit(1);
  }

  if (!raw.includes('-pooler')) {
    console.warn('\n⚠️  That is the DIRECT connection string, not the pooled one.');
    console.warn('   Serverless functions open and close connections constantly and will');
    console.warn('   exhaust it. Go back to Neon and switch "Pooled connection" ON —');
    console.warn('   the host should contain "-pooler".\n');
    process.exit(1);
  }

  const url = raw.includes('sslmode=')
    ? raw
    : raw + (raw.includes('?') ? '&' : '?') + 'sslmode=require';

  // Replace DATABASE_URL if present, otherwise append it; drop USE_PGLITE so the app
  // actually switches drivers.
  let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  env = env
    .split('\n')
    .filter((line) => !/^\s*(DATABASE_URL|USE_PGLITE)\s*=/.test(line))
    .filter((line) => !/^# \(inactive.*DATABASE_URL=/.test(line))
    .join('\n')
    .trimEnd();
  env += '\nDATABASE_URL=' + url + '\n';
  fs.writeFileSync(ENV, env);

  console.log('\n.env updated -> ' + redact(url));
  console.log('\nCreating tables in Neon…');

  const run = (args) =>
    execFileSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

  run([path.join(__dirname, 'setup-db.cjs')]);

  console.log('\nRunning the test suite against Neon…\n');
  try {
    run([path.join(__dirname, 'test.cjs')]);
    console.log('\nNeon is ready. Put this same string into Vercel as DATABASE_URL.');
    console.log('Your local .env now points at Neon too — to go back to the offline');
    console.log('database, delete the DATABASE_URL line from .env.\n');
  } catch {
    console.error('\nTests failed against Neon. The connection works but something else is wrong.');
    process.exit(1);
  }
})();
