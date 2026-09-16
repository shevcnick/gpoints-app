// Shared helpers used by every page.

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  // 401 anywhere means the session is gone: bounce to login rather than showing errors.
  if (res.status === 401 && !path.startsWith('/auth')) {
    location.href = '/login';
    throw new Error('Not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function show(el, message, kind = 'err') {
  if (!el) return;
  el.textContent = message;
  el.className = 'msg ' + kind;
}
const clear = (el) => { if (el) { el.textContent = ''; el.className = 'msg'; } };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (n) => Number(n).toLocaleString();
const signed = (n) => (n > 0 ? '+' : '') + num(n);
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

const UNITS = [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];

function span(secs) {
  for (const [size, label] of UNITS) {
    if (secs >= size) return Math.floor(secs / size) + label;
  }
  return null;
}

function ago(ts) {
  if (!ts) return '';
  const s = span((Date.now() - new Date(ts)) / 1000);
  return s ? s + ' ago' : 'just now';
}

// Time remaining. Separate from ago() because a future date run through ago() reads
// as "just now", which is exactly wrong for a deadline.
function until(ts) {
  if (!ts) return '';
  const secs = (new Date(ts) - Date.now()) / 1000;
  if (secs <= 0) return 'expired';
  const s = span(secs);
  return s ? s + ' left' : 'under a minute left';
}

const NAV = [
  ['/',            '🏆', 'Board'],
  ['/pending',     '🗳️', 'Vote'],
  ['/propose',     '➕', 'Propose'],
  ['/feed',        '📜', 'Feed'],
  ['/account',     '👤', 'You'],
];

// Renders the bottom nav and, if there is anything to vote on, a count badge on Vote.
async function renderNav(user) {
  const here = location.pathname.replace(/\/$/, '') || '/';
  const links = NAV.map(([href, icon, label]) => {
    const active = href === here ? ' class="active"' : '';
    const badge = href === '/pending' ? '<i class="badge" hidden></i>' : '';
    return `<a href="${href}"${active}><span>${icon}</span>${label}${badge}</a>`;
  });
  if (user?.is_admin) {
    const active = here === '/admin' ? ' class="active"' : '';
    links.push(`<a href="/admin"${active}><span>⚙️</span>Admin</a>`);
  }
  const nav = document.createElement('nav');
  nav.innerHTML = links.join('');
  document.body.appendChild(nav);

  try {
    const { proposals } = await api('/proposals?status=open');
    const votable = proposals.filter((p) => !p.blocked).length;
    const badge = nav.querySelector('.badge');
    if (badge && votable > 0) { badge.textContent = votable; badge.hidden = false; }
  } catch { /* badge is decorative; never block the page on it */ }
}

// Every logged-in page starts with this: confirms the session, draws the nav.
async function boot() {
  let user;
  try {
    ({ user } = await api('/auth/session'));
  } catch {
    location.href = '/login';
    throw new Error('redirecting');
  }
  renderNav(user);
  return user;
}
