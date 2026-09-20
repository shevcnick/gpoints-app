# G Points

Award and deduct G points among friends. Nobody can hand themselves points: every change is
a **proposal**, and **3 neutral friends** must accept it. Neither the person proposing nor the
person receiving gets a vote.

Leaderboards for the week, month, year and all time, with a live countdown to the next
rollover. Weeks run Sunday 12:00 AM to Sunday 12:00 AM Toronto time and are numbered Week 1, 2,
3… from the start of the season. The Hall of Fame keeps G of the Week, G of the Month and
G of the Year.

---

## Running it locally

```bash
npm install
npm run db:reset          # creates the database and 6 test users (password: test)
node scripts/demo-data.cjs   # optional: fills it with fake activity
npm start                 # http://localhost:5000
```

Log in as `alice` (she is the admin) with password `test`. Other test users: `bob`, `carol`,
`dave`, `erin`, `frank`.

With no `DATABASE_URL` set, the app runs on **PGlite** — real Postgres compiled to WASM,
stored in `./.pglite`, no server and no password needed. Set `DATABASE_URL` and it switches
to normal Postgres. Same code either way.

```bash
npm test                  # 54 end-to-end tests
```

Two things to know about the local PGlite database:
- It is **single-process**. Stop the server before running a script against it.
- Stop the server with **Ctrl+C**, not by killing the window. A hard kill mid-write can
  corrupt `./.pglite`; if that happens, delete the folder and run `npm run db:reset`.

Neither applies once you are on Neon, where the database is a separate server.

---

## Putting it online (free)

Three accounts, all free, about 15 minutes. Nothing here needs a credit card.

### 1. Push to GitHub

Make a **private** repo at [github.com/new](https://github.com/new) — call it `gpoints-app`,
and do **not** tick "Add a README". Then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/gpoints-app.git
git branch -M main
git push -u origin main
```

`.env` is gitignored, so no secrets go up.

### 2. Create the database on Neon

1. Sign up at [neon.tech](https://neon.tech) with your GitHub account.
2. Create a project — name it `gpoints`, any region near you.
3. Copy the connection string. **Take the pooled one**: the host contains `-pooler`. There is
   a "Pooled connection" toggle or a separate copy button for it.

It looks like this:

```
postgresql://USER:PASSWORD@ep-something-pooler.REGION.aws.neon.tech/neondb?sslmode=require
```

The pooled host matters: serverless functions open and close connections constantly and will
exhaust a direct connection.

Now create the tables. Put the Neon URL in your local `.env` temporarily:

```bash
DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=require
```

```bash
npm run db:setup
```

That applies `db/schema.sql` to Neon and starts season 2026. Run `npm test` too — it exercises
every rule against the real production database, which is worth doing once before you invite
anyone. Then remove `DATABASE_URL` from `.env` again so local dev goes back to PGlite.

### 3. Deploy on Vercel

1. Sign up at [vercel.com](https://vercel.com) with GitHub.
2. **Add New → Project**, import `gpoints-app`.
3. Framework Preset: **Other**. No build command, no output directory — leave them empty.
4. Add these **Environment Variables** before deploying:

| Name | Value |
|---|---|
| `DATABASE_URL` | your Neon **pooled** connection string |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `INVITE_CODE` | whatever you want to tell your friends |
| `VOTES_REQUIRED` | `3` |
| `APP_TZ` | `America/Toronto` |
| `NODE_ENV` | `production` |

5. Deploy. You get a URL like `gpoints-app.vercel.app`.

`NODE_ENV=production` matters: it makes the session cookie `Secure`, so it is only ever sent
over HTTPS.

### 4. Admin

Sign up with the username `nick` and you are admin automatically — no SQL needed. To use a
different username, set `ADMIN_USERNAMES` in Vercel before signing up.

Admins can edit anyone's display name, username and avatar, delete any proposal, reverse
an approved transaction, download the archive and close the season.

Anyone can cancel their **own** proposal while it is still open — it leaves the voting list
but stays on the record as cancelled. Deleting (admin only) removes the row entirely.
Reversing is different again: it takes awarded points back off and says publicly why.

### 5. Invite everyone

Send them the URL and the invite code. **You need at least 5 people** — with the proposer and
the receiver both sitting out, 3 neutral voters means 5 members minimum before anything can
pass. At exactly 5, every proposal needs all 3 remaining people to agree.

If the group stays small, set `VOTES_REQUIRED=2` in Vercel and redeploy.

Every `git push` to `main` redeploys automatically.

---

## Closing the year

On Jan 1, as admin: **Admin → Download archive** first, then type the season name and
**Close season**.

Nothing is deleted. Proposals keep their `season_id` and stay in the database forever; the
leaderboards simply scope to the active season, so closing one puts everyone back to zero.
Final standings are frozen into the Hall of Fame, and any open votes are retired.

---

## How it fits together

```
api/index.js          Vercel entry — exports the Express app
server.js             local dev — adds app.listen() and a clean shutdown
src/app.js            routers, static files, error handler
src/db.js             pg (production) or PGlite (local) behind one interface
src/auth.js           bcrypt + a signed stateless cookie (no session store)
src/routes/           auth, proposals+votes, leaderboard, account, seasons, admin
public/               the whole frontend: plain HTML, one CSS file, no build step
db/schema.sql         tables, constraints and the ledger view
src/periods.js        week/month/year boundaries in APP_TZ
src/discord.js        optional Discord webhook notifications
scripts/test.cjs      54 end-to-end tests
```

**There are no stored balances anywhere.** Approved proposals *are* the ledger, so all four
leaderboards are one query with a different `WHERE`, and any total can be traced back to the
proposal that caused it. That is also why closing a season resets everyone without a cron job
or a reset script.

**The vote endpoint** is the one place a race could mint points twice, so reading the
proposal, inserting the vote and flipping the status all happen inside a transaction against
a `SELECT ... FOR UPDATE` row. A composite primary key on `votes` makes double-voting
impossible at the database level, not just in application code.

Passwords are **bcrypt hashed** — nobody can read them, including you.

**The Hall of Fame is computed, not stored.** Past winners are derived from the ledger on
demand, so there is no scheduled job that can miss a rollover. The trade-off: reversing an
old transaction can retroactively change who won a past week.

## Environment variables

| Name | What it does |
|---|---|
| `DATABASE_URL` | Postgres connection string. Absent = PGlite locally. |
| `SESSION_SECRET` | Signs the session cookie. Changing it logs everyone out. |
| `INVITE_CODE` | Needed to sign up. Case and whitespace insensitive. |
| `VOTES_REQUIRED` | Neutral accepts needed to carry a proposal. Default 3. |
| `ADMIN_USERNAMES` | Whoever signs up with one of these is admin automatically. Default `nick`. |
| `APP_TZ` | IANA timezone for period boundaries, e.g. `America/Toronto`. An invalid name falls back to Toronto with a warning rather than breaking the site. |
| `NODE_ENV` | Set to `production` in Vercel so cookies are `Secure`. |
| `DISCORD_WEBHOOK_URL` | Optional. Posts to Discord when a proposal opens, lands or is reversed. |
| `APP_URL` | Optional. Your live URL, so Discord messages link to the voting page. |

All of them are read **at startup**. Change one and you must restart locally, or redeploy on
Vercel.
