// Week, month and year boundaries, all in APP_TZ (default America/New_York).
//
// A week runs Sunday 00:00 to the following Sunday 00:00. Postgres date_trunc('week')
// starts weeks on MONDAY, so every week expression here shifts by a day and back.
//
// Nothing about periods is stored. Winners are computed from the ledger on demand, so
// there is no cron job to miss a rollover and no snapshot that can disagree with the
// underlying points.

const DEFAULT_TZ = 'America/Toronto';

// A bad APP_TZ makes every date operation throw, which takes the whole site down for a
// typo in a config box. Validate once, warn loudly, and keep running on the default.
let resolvedTz = null;
function tz() {
  if (resolvedTz) return resolvedTz;
  const wanted = (process.env.APP_TZ || '').trim();
  if (!wanted) return (resolvedTz = DEFAULT_TZ);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: wanted }).format(new Date());
    return (resolvedTz = wanted);
  } catch {
    console.error(
      `APP_TZ is not a valid timezone: ${JSON.stringify(wanted)}. `
      + `Falling back to ${DEFAULT_TZ}. It must be an IANA name like "America/Toronto" `
      + `— the region prefix is required.`
    );
    return (resolvedTz = DEFAULT_TZ);
  }
}

// SQL for the start of the week containing `ts`, as a timestamptz.
// $tz must be bound separately by the caller.
const weekStartSQL = (ts, tzParam) =>
  `((date_trunc('week', (${ts} AT TIME ZONE ${tzParam}) + interval '1 day')`
  + ` - interval '1 day') AT TIME ZONE ${tzParam})`;

const monthStartSQL = (ts, tzParam) =>
  `(date_trunc('month', ${ts} AT TIME ZONE ${tzParam}) AT TIME ZONE ${tzParam})`;

const yearStartSQL = (ts, tzParam) =>
  `(date_trunc('year', ${ts} AT TIME ZONE ${tzParam}) AT TIME ZONE ${tzParam})`;

// Lower bound on ledger.resolved_at for each leaderboard tab.
function windowClause(name, tzParam) {
  switch (name) {
    case 'week':  return `l.resolved_at >= ${weekStartSQL('now()', tzParam)}`;
    case 'month': return `l.resolved_at >= ${monthStartSQL('now()', tzParam)}`;
    case 'year':  return `l.resolved_at >= ${yearStartSQL('now()', tzParam)}`;
    case 'all':   return 'true';
    default:      return null;
  }
}

// --- JS-side date maths, for labelling and the countdown ---------------------

// What the wall clock reads in `timeZone` at instant `date`, as a plain object.
function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    weekday: 'short', hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute, second: +out.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

// The UTC instant at which the given wall-clock time occurs in `timeZone`.
// Guessing then correcting by the observed offset handles DST without a library.
function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const seen = parts(new Date(guess), timeZone);
  const seenAsUtc = Date.UTC(
    seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second
  );
  return new Date(guess - (seenAsUtc - guess));
}

// Shift a calendar date by whole days. Done on the date itself rather than by adding
// milliseconds, because on DST changeover days a "day" is 23 or 25 hours and millisecond
// arithmetic slides the boundary off midnight.
function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Midnight starting the Sunday on or before `date`.
function weekStart(date, timeZone) {
  const p = parts(date, timeZone);
  const sunday = addDays(p, -p.weekday);
  return zonedTimeToUtc(sunday, timeZone);
}

function weekEnd(date, timeZone) {
  const p = parts(date, timeZone);
  const nextSunday = addDays(p, 7 - p.weekday);
  return zonedTimeToUtc(nextSunday, timeZone);
}

function monthStart(date, timeZone) {
  const p = parts(date, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: 1 }, timeZone);
}

function monthEnd(date, timeZone) {
  const p = parts(date, timeZone);
  const nextMonth = p.month === 12 ? 1 : p.month + 1;
  const nextYear = p.month === 12 ? p.year + 1 : p.year;
  return zonedTimeToUtc({ year: nextYear, month: nextMonth, day: 1 }, timeZone);
}

const yearStart = (date, timeZone) =>
  zonedTimeToUtc({ year: parts(date, timeZone).year, month: 1, day: 1 }, timeZone);

const yearEnd = (date, timeZone) =>
  zonedTimeToUtc({ year: parts(date, timeZone).year + 1, month: 1, day: 1 }, timeZone);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const monthName = (date, timeZone) => MONTHS[parts(date, timeZone).month - 1];

// Weeks are numbered from the first week of the season, so the count resets each year
// alongside the leaderboards: the week containing Jan 1 is Week 1.
function weekNumber(date, seasonStart, timeZone) {
  // Compare calendar dates, not instants: across a DST change the gap between two
  // Sunday midnights is 167 or 169 hours, and dividing milliseconds by 7 days would
  // occasionally land a week early.
  const asUTCDate = (d) => {
    const p = parts(weekStart(d, timeZone), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day);
  };
  const days = (asUTCDate(date) - asUTCDate(seasonStart)) / 86400000;
  // A week can only predate the season if data was backdated; never label it Week 0
  // or a negative number.
  return Math.max(1, Math.floor(days / 7) + 1);
}

// Everything the UI needs to label the current moment and count down to the rollovers.
function describeNow(seasonStart, now = new Date()) {
  const timeZone = tz();
  const p = parts(now, timeZone);
  return {
    timezone: timeZone,
    week: {
      number: weekNumber(now, seasonStart, timeZone),
      startsAt: weekStart(now, timeZone).toISOString(),
      endsAt: weekEnd(now, timeZone).toISOString(),
    },
    month: {
      name: monthName(now, timeZone),
      startsAt: monthStart(now, timeZone).toISOString(),
      endsAt: monthEnd(now, timeZone).toISOString(),
    },
    year: {
      name: String(p.year),
      startsAt: yearStart(now, timeZone).toISOString(),
      endsAt: yearEnd(now, timeZone).toISOString(),
    },
  };
}

module.exports = {
  tz, windowClause, weekStartSQL, monthStartSQL, yearStartSQL,
  parts, zonedTimeToUtc, weekStart, weekEnd, monthStart, monthEnd,
  yearStart, yearEnd, monthName, weekNumber, describeNow, MONTHS,
};
