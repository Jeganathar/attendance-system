const TZ = 'Asia/Kolkata';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  if (location.protocol === 'file:') throw new Error('Open the app at http://localhost:3000 (start the server with "npm start"). Do not open the HTML files directly.');
  let r;
  try {
    r = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch {
    throw new Error('Cannot reach the server. Check that it is running ("npm start" shows "Attendance system running") and that you opened the same address it printed.');
  }
  let d = {};
  try { d = await r.json(); } catch { }
  if (r.status === 401 && path !== '/login') { location.href = '/'; throw new Error('Session expired'); }
  if (r.status === 403) { location.href = '/'; throw new Error('Not allowed'); }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
const post = (p, body = {}) => api(p, { method: 'POST', body });
const put = (p, body = {}) => api(p, { method: 'PUT', body });

const fmtT = ms => ms ? new Date(ms).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase() : '-';
const fmtD = d => d ? new Date(d + 'T00:00:00+05:30').toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const fmtDur = m => { m = Math.round(m || 0); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
const hm = ms => ms ? new Date(ms + 19800000).toISOString().slice(11, 16) : '';
const ymd = ms => new Date(ms + 19800000).toISOString().slice(0, 10);

function toast(msg, err) {
  let box = $('#toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 't' + (err ? ' err' : ''); t.setAttribute('role', err ? 'alert' : 'status'); t.textContent = msg;
  box.appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 4500);
}
async function run(fn) { try { await fn(); } catch (e) { toast(e.message, true); } }

function startClock(el) {
  const t = () => el.textContent = new Date().toLocaleString('en-IN', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toUpperCase() + ' IST';
  t(); setInterval(t, 1000);
}
async function logout() { await post('/logout'); location.href = '/'; }
async function changePassword() {
  const current = prompt('Current password'); if (current === null) return;
  const next = prompt('New password (at least 8 characters)'); if (next === null) return;
  run(async () => toast((await post('/password', { current, next })).message));
}
const flagsHtml = r => [
  r.late ? '<span class="flag late">Late</span>' : '',
  r.early ? '<span class="flag early">Early leave</span>' : '',
  ...(r.warnings || []).map(w => `<span class="flag warn" title="${esc(w)}">Break alert</span>`)
].join('');
const STATUS = { not_in: 'Not logged in', working: 'Working', on_break: 'On break', checked_out: 'Checked out', forgot_logout: 'Forgot to log out' };
