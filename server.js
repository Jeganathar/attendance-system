const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { db, tx, init } = require('./db');

const IST = 19800000; // UTC+05:30, no DST
const MIN = 60000;
const dateOf = ms => new Date(ms + IST).toISOString().slice(0, 10);
const toMs = (d, t) => (/^\d{4}-\d\d-\d\d$/.test(d || '') && /^\d\d:\d\d$/.test(t || '')) ? Date.parse(`${d}T${t}:00+05:30`) : null;
const fmtHM = ms => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
const fmtDur = m => { m = Math.round(m); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
const cfg = async (d = db) => JSON.parse((await d.get("select value from settings where key='config'")).value);
const isDup = e => e && e.code === '23505';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const audit = (d, actor, action, details) =>
  d.run('insert into audit_log(actor_id,action,details,created_at) values(?,?,?,?)', [actor, action, JSON.stringify(details || {}), Date.now()]);
const h = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).then(r => { if (r !== undefined) res.json(r); }).catch(next);

const app = express();
app.set('trust proxy', 1);
app.get('/api/health', (req, res) => res.json({ ok: true })); // does not touch the database (lets Neon sleep)
app.use(express.json({ limit: '100kb' }));
let sessionKey = null;
app.use((req, res, next) => cookieSession({
  name: 'sess', keys: [sessionKey], maxAge: 12 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production'
})(req, res, next));
app.use((req, res, next) => { // JSON-only API as basic CSRF defence
  if (['POST', 'PUT'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const guard = role => async (req, res, next) => {
  try {
    const u = req.session.uid && await db.get('select id,name,email,role,department,active from users where id=?', [req.session.uid]);
    if (!u || !u.active) { req.session = null; return res.status(401).json({ error: 'Please log in' }); }
    if (role && u.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = u; next();
  } catch (e) { next(e); }
};

/* ---------- attendance calculations ---------- */
function calc(a, bs, c, n) {
  const end = a.check_out || n;
  const gross = Math.max(0, end - a.check_in);
  let brk = 0, unpaid = 0, open_break = null; const warnings = [];
  for (const b of bs) {
    const d = Math.max(0, (b.end_ms || n) - b.start_ms);
    const p = c.breaks[b.type];
    brk += d;
    if (!p || !p.paid) unpaid += d;
    if (!b.end_ms) open_break = b;
    if (p && p.max_minutes && d > p.max_minutes * MIN) {
      warnings.push(b.end_ms
        ? `${p.label} exceeded the limit (${fmtDur(d / MIN)}, max ${p.max_minutes}m).`
        : `${p.label} has been running for ${fmtDur(d / MIN)} (max ${p.max_minutes}m) - end it if you are back.`);
    }
  }
  return {
    gross_min: Math.round(gross / MIN), break_min: Math.round(brk / MIN),
    unpaid_break_min: Math.round(unpaid / MIN), net_min: Math.max(0, Math.round((gross - unpaid) / MIN)),
    warnings, open_break
  };
}
async function loadBreaks(d, atts) {
  const ids = atts.map(a => a.id), by = {};
  if (!ids.length) return by;
  for (const b of await d.all('select * from breaks where attendance_id = any(?) order by start_ms', [ids])) (by[b.attendance_id] ||= []).push(b);
  return by;
}
function buildSummary(date, atts, by, c, n) {
  const recs = atts.map(a => { const bs = by[a.id] || []; return { ...a, breaks: bs, ...calc(a, bs, c, n) }; });
  const sum = k => recs.reduce((s, r) => s + r[k], 0);
  const closed = recs.length > 0 && recs.every(r => r.check_out);
  const first_in = recs.length ? recs[0].check_in : null;
  const last_out = closed ? recs[recs.length - 1].check_out : null;
  const late = first_in ? first_in > toMs(date, c.office_start) + c.grace_minutes * MIN : false;
  const early = closed ? last_out < toMs(date, c.office_end) : false;
  if (recs.length) { recs[0].late = late; if (closed) recs[recs.length - 1].early = early; }
  return {
    date, records: recs, sessions: recs.length, first_in, last_out, late, early,
    gross_min: sum('gross_min'), break_min: sum('break_min'), net_min: sum('net_min'),
    warnings: recs.flatMap(r => r.warnings)
  };
}
async function daySummary(d, uid, date, c, n) {
  const atts = await d.all('select * from attendance where user_id=? and date=? order by check_in', [uid, date]);
  return buildSummary(date, atts, await loadBreaks(d, atts), c, n);
}
const openSession = (d, uid) => d.get('select * from attendance where user_id=? and check_out is null', [uid]);
async function overlaps(d, uid, inMs, outMs, excludeId) {
  return !!(await d.get('select 1 as x from attendance where user_id=? and id!=? and check_in<? and (check_out is null or check_out>?)',
    [uid, excludeId || 0, outMs || 8e15, inMs]));
}
async function closeOpenBreaks(d, attId, outMs) {
  await d.run('delete from breaks where attendance_id=? and end_ms is null and start_ms>=?', [attId, outMs]);
  await d.run('update breaks set end_ms=? where attendance_id=? and end_ms is null', [outMs, attId]);
}

/* ---------- auth ---------- */
const attempts = new Map();
app.post('/api/login', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), key = req.ip + '|' + email;
  const rec = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 15 * MIN) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 8) bad('Too many failed attempts. Try again in 15 minutes.', 429);
  const u = await db.get('select * from users where email=?', [email]);
  if (!u || !u.active || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    rec.n++; attempts.set(key, rec); bad('Incorrect email or password', 401);
  }
  attempts.delete(key);
  req.session = { uid: u.id };
  return { role: u.role, name: u.name };
}));
app.post('/api/logout', h(req => { req.session = null; return { ok: true }; }));
app.get('/api/me', guard(), h(req => req.user));
app.post('/api/password', guard(), h(async req => {
  const u = await db.get('select * from users where id=?', [req.user.id]);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.password_hash)) bad('Current password is incorrect');
  if (String(req.body.next || '').length < 8) bad('New password must be at least 8 characters');
  await db.run('update users set password_hash=? where id=?', [bcrypt.hashSync(req.body.next, 10), u.id]);
  await audit(db, u.id, 'password_change', {});
  return { message: 'Password updated' };
}));

/* ---------- staff: today & actions ---------- */
function statusOf(open, todayCount, today, openBreak) {
  if (open && open.date < today) return 'forgot_logout';
  if (open) return openBreak ? 'on_break' : 'working';
  return todayCount ? 'checked_out' : 'not_in';
}
app.get('/api/staff/state', guard('staff'), h(async req => {
  const c = await cfg(), n = Date.now(), today = dateOf(n), uid = req.user.id;
  const open = await openSession(db, uid);
  const s = await daySummary(db, uid, today, c, n);
  let oe = open && s.records.find(r => r.id === open.id);
  if (open && !oe) { const by = await loadBreaks(db, [open]); const bs = by[open.id] || []; oe = { ...open, breaks: bs, ...calc(open, bs, c, n) }; }
  const warnings = [...s.warnings];
  if (open && open.date < today) warnings.push(...oe.warnings);
  return {
    user: req.user, now: n, date: today,
    config: { office_start: c.office_start, office_end: c.office_end, breaks: c.breaks },
    status: statusOf(open, s.sessions, today, oe && oe.open_break),
    open: oe || null, open_break: oe ? oe.open_break : null,
    stale: open && open.date < today ? open : null,
    sessions: s.records,
    totals: { gross_min: s.gross_min, break_min: s.break_min, net_min: s.net_min },
    warnings
  };
}));

app.post('/api/staff/checkin', guard('staff'), h(req => tx(async t => {
  const n = Date.now(), today = dateOf(n), open = await openSession(t, req.user.id);
  if (open && open.date < today) bad(`You have an unclosed session from ${open.date}. Submit a missed check-out request first.`);
  if (open) bad('You are already checked in. Check out first.');
  await t.run("insert into attendance(user_id,date,check_in,source,created_at) values(?,?,?,'self',?)", [req.user.id, today, n, n]);
  return { message: `Checked in at ${fmtHM(n)}` };
})));
app.post('/api/staff/checkout', guard('staff'), h(req => tx(async t => {
  const n = Date.now(), c = await cfg(t), open = await openSession(t, req.user.id);
  if (!open) bad('You are not checked in.');
  if (open.date < dateOf(n)) bad('This session is from a previous day. Submit a missed check-out request.');
  const ob = await t.get('select * from breaks where attendance_id=? and end_ms is null', [open.id]);
  if (ob) bad(`End your ${c.breaks[ob.type]?.label || 'break'} before checking out.`);
  await t.run('update attendance set check_out=? where id=?', [n, open.id]);
  const by = await loadBreaks(t, [open]);
  const r = calc({ ...open, check_out: n }, by[open.id] || [], c, n);
  return { message: `Checked out at ${fmtHM(n)}. Office time ${fmtDur(r.gross_min)}, breaks ${fmtDur(r.break_min)}, net working time ${fmtDur(r.net_min)}.` };
})));
app.post('/api/staff/break/start', guard('staff'), h(req => tx(async t => {
  const n = Date.now(), c = await cfg(t), type = req.body.type;
  if (!c.breaks[type]) bad('Unknown break type');
  const open = await openSession(t, req.user.id);
  if (!open || open.date < dateOf(n)) bad('Check in before starting a break.');
  const ob = await t.get('select * from breaks where user_id=? and end_ms is null', [req.user.id]);
  if (ob) bad(`Your ${c.breaks[ob.type]?.label || 'break'} is still running. End it first.`);
  await t.run('insert into breaks(attendance_id,user_id,type,start_ms) values(?,?,?,?)', [open.id, req.user.id, type, n]);
  return { message: `${c.breaks[type].label} started at ${fmtHM(n)}` };
})));
app.post('/api/staff/break/end', guard('staff'), h(req => tx(async t => {
  const n = Date.now(), c = await cfg(t);
  const ob = await t.get('select * from breaks where user_id=? and end_ms is null', [req.user.id]);
  if (!ob) bad('You have no running break.');
  await t.run('update breaks set end_ms=? where id=?', [n, ob.id]);
  return { message: `${c.breaks[ob.type]?.label || 'Break'} ended at ${fmtHM(n)} (${fmtDur((n - ob.start_ms) / MIN)})` };
})));

const validRange = (from, to) => /^\d{4}-\d\d-\d\d$/.test(from || '') && /^\d{4}-\d\d-\d\d$/.test(to || '');
app.get('/api/staff/history', guard('staff'), h(async req => {
  const n = Date.now(), c = await cfg();
  const to = req.query.to || dateOf(n), from = req.query.from || to.slice(0, 8) + '01';
  if (!validRange(from, to)) bad('Invalid date range');
  const atts = await db.all('select * from attendance where user_id=? and date between ? and ? order by date desc, check_in', [req.user.id, from, to]);
  const by = await loadBreaks(db, atts), groups = new Map();
  for (const a of atts) { if (!groups.has(a.date)) groups.set(a.date, []); groups.get(a.date).push(a); }
  const days = [...groups].map(([date, list]) => buildSummary(date, list, by, c, n));
  return { from, to, days, total_net_min: days.reduce((s, d) => s + d.net_min, 0), total_break_min: days.reduce((s, d) => s + d.break_min, 0), days_present: days.length };
}));

/* ---------- corrections (staff side) ---------- */
app.post('/api/staff/corrections', guard('staff'), h(async req => {
  const n = Date.now(), b = req.body, t = b.type, uid = req.user.id;
  const reason = String(b.reason || '').trim();
  if (reason.length < 5) bad('Please give a reason (at least 5 characters).');
  let in_ms = null, out_ms = null, att = null;
  if (t === 'missed_checkin') {
    in_ms = toMs(b.date, b.in_time);
    if (!in_ms) bad('Enter the actual arrival date and time.');
    if (b.out_time) { out_ms = toMs(b.date, b.out_time); if (!out_ms || out_ms <= in_ms) bad('Leaving time must be after the arrival time.'); }
  } else if (t === 'missed_checkout') {
    att = await openSession(db, uid);
    if (!att) bad('You have no open session to close.');
    out_ms = toMs(b.date || att.date, b.out_time);
    if (!out_ms) bad('Enter the actual leaving date and time.');
    if (out_ms <= att.check_in) bad('Leaving time must be after your check-in time.');
  } else if (t === 'correction') {
    att = await db.get('select * from attendance where id=? and user_id=?', [Number(b.attendance_id) || 0, uid]);
    if (!att) bad('Choose the attendance record to correct.');
    if (b.in_time) in_ms = toMs(att.date, b.in_time);
    if (b.out_time) out_ms = toMs(b.out_date || att.date, b.out_time);
    if (!in_ms && !out_ms) bad('Enter the corrected check-in and/or check-out time.');
    if ((in_ms || att.check_in) >= (out_ms || att.check_out || 8e15)) bad('Check-out must be after check-in.');
  } else bad('Invalid request type');
  if ((in_ms && in_ms > n) || (out_ms && out_ms > n)) bad('Times cannot be in the future.');
  const r = await db.run('insert into corrections(user_id,type,attendance_id,in_ms,out_ms,reason,created_at) values(?,?,?,?,?,?,?) returning id',
    [uid, t, att ? att.id : null, in_ms, out_ms, reason, n]);
  await audit(db, uid, 'correction_request', { id: r.id, type: t });
  return { message: 'Request sent to admin for approval.' };
}));
const corrQuery = `select c.*, u.name as user_name, a.check_in as att_in, a.check_out as att_out, a.date as att_date
  from corrections c join users u on u.id=c.user_id left join attendance a on a.id=c.attendance_id`;
app.get('/api/staff/corrections', guard('staff'), h(req =>
  db.all(corrQuery + ' where c.user_id=? order by c.id desc limit 100', [req.user.id])));

/* ---------- admin: today ---------- */
app.get('/api/admin/today', guard('admin'), h(async () => {
  const c = await cfg(), n = Date.now(), today = dateOf(n);
  const staff = await db.all("select id,name,email,department from users where role='staff' and active=1 order by name");
  const todays = await db.all('select * from attendance where date=? order by check_in', [today]);
  const opens = await db.all('select * from attendance where check_out is null');
  const all = [...todays, ...opens.filter(o => !todays.some(t => t.id === o.id))];
  const by = await loadBreaks(db, all);
  const byUser = {}; for (const a of todays) (byUser[a.user_id] ||= []).push(a);
  const openBy = Object.fromEntries(opens.map(a => [a.user_id, a]));
  const counts = { total: staff.length, working: 0, on_break: 0, checked_out: 0, not_in: 0, forgot_logout: 0, late: 0 };
  const rows = staff.map(u => {
    const s = buildSummary(today, byUser[u.id] || [], by, c, n), o = openBy[u.id];
    const oe = o ? { ...o, ...calc(o, by[o.id] || [], c, n) } : null;
    const status = statusOf(o, s.sessions, today, oe && oe.open_break);
    const warnings = [...s.warnings];
    if (status === 'forgot_logout') warnings.push(`Did not check out on ${o.date} (checked in ${fmtHM(o.check_in)}).`, ...oe.warnings);
    counts[status]++; if (s.late) counts.late++;
    return {
      ...u, status, first_in: s.first_in, last_out: s.last_out, late: s.late, early: s.early,
      gross_min: s.gross_min, break_min: s.break_min, net_min: s.net_min, sessions: s.sessions,
      open_since: o ? o.check_in : null, open_date: o ? o.date : null,
      break_type: oe && oe.open_break ? c.breaks[oe.open_break.type]?.label : null,
      break_since: oe && oe.open_break ? oe.open_break.start_ms : null, warnings
    };
  });
  return { now: n, date: today, office_start: c.office_start, office_end: c.office_end, counts, staff: rows };
}));

/* ---------- admin: account management (admins only) ---------- */
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
app.get('/api/admin/users', guard('admin'), h(() =>
  db.all('select id,name,email,role,department,active,created_at from users order by active desc, name')));
app.post('/api/admin/users', guard('admin'), h(async req => {
  const b = req.body, name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (!name) bad('Name is required');
  if (!emailOk(email)) bad('Enter a valid email');
  if (String(b.password || '').length < 8) bad('Password must be at least 8 characters');
  const role = b.role === 'admin' ? 'admin' : 'staff';
  try {
    const r = await db.run('insert into users(name,email,password_hash,role,department,created_at) values(?,?,?,?,?,?) returning id',
      [name, email, bcrypt.hashSync(b.password, 10), role, String(b.department || '').trim(), Date.now()]);
    await audit(db, req.user.id, 'user_create', { id: r.id, email, role });
    return { message: role === 'admin' ? 'Admin account created' : 'Staff account created' };
  } catch (e) { if (isDup(e)) bad('That email is already in use', 409); throw e; }
}));
app.put('/api/admin/users/:id', guard('admin'), h(async req => {
  const id = Number(req.params.id), u = await db.get('select * from users where id=?', [id]);
  if (!u) bad('Not found', 404);
  const b = req.body, name = String(b.name ?? u.name).trim(), email = String(b.email ?? u.email).trim().toLowerCase();
  const role = b.role ? (b.role === 'admin' ? 'admin' : 'staff') : u.role, active = b.active === undefined ? u.active : (b.active ? 1 : 0);
  if (!name) bad('Name is required');
  if (!emailOk(email)) bad('Enter a valid email');
  if (id === req.user.id && (!active || role !== 'admin')) bad('You cannot deactivate or demote your own account');
  if (b.password && String(b.password).length < 8) bad('Password must be at least 8 characters');
  try {
    await db.run('update users set name=?,email=?,role=?,department=?,active=? where id=?',
      [name, email, role, String(b.department ?? u.department).trim(), active, id]);
    if (b.password) await db.run('update users set password_hash=? where id=?', [bcrypt.hashSync(b.password, 10), id]);
  } catch (e) { if (isDup(e)) bad('That email is already in use', 409); throw e; }
  await audit(db, req.user.id, 'user_update', { id, active, role });
  return { message: 'Saved' };
}));
app.delete('/api/admin/users/:id', guard('admin'), h(async req => {
  const id = Number(req.params.id);
  if (id === req.user.id) bad('You cannot remove your own account');
  if (!(await db.get('select 1 as x from users where id=?', [id]))) bad('Not found', 404);
  const hasData = (await db.get('select 1 as x from attendance where user_id=?', [id])) || (await db.get('select 1 as x from corrections where user_id=?', [id]));
  if (req.query.hard === '1') {
    if (hasData) bad('This person has attendance history, so they can only be deactivated.', 409);
    await db.run('delete from users where id=?', [id]);
    await audit(db, req.user.id, 'user_delete', { id });
    return { message: 'Account deleted' };
  }
  await db.run('update users set active=0 where id=?', [id]);
  await audit(db, req.user.id, 'user_deactivate', { id });
  return { message: 'Account deactivated' };
}));

/* ---------- admin: attendance history & edits ---------- */
app.get('/api/admin/attendance', guard('admin'), h(async req => {
  const n = Date.now(), c = await cfg(), to = req.query.to || dateOf(n), from = req.query.from || dateOf(n - 6 * 86400000);
  if (!validRange(from, to)) bad('Invalid date range');
  const uid = Number(req.query.user_id) || 0;
  const atts = await db.all(`select a.*, u.name as user_name from attendance a join users u on u.id=a.user_id
    where a.date between ? and ? ${uid ? 'and a.user_id=?' : ''} order by a.date desc, u.name, a.check_in limit 3000`, uid ? [from, to, uid] : [from, to]);
  const by = await loadBreaks(db, atts), groups = new Map();
  for (const a of atts) { const k = a.user_id + '|' + a.date; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  const records = []; let total = 0;
  for (const list of groups.values()) {
    const s = buildSummary(list[0].date, list, by, c, n); total += s.net_min;
    s.records.forEach(r => records.push(r));
  }
  return { from, to, records, total_net_min: total };
}));
app.put('/api/admin/attendance/:id', guard('admin'), h(req => tx(async t => {
  const a = await t.get('select * from attendance where id=?', [Number(req.params.id) || 0]);
  if (!a) bad('Not found', 404);
  const b = req.body, reason = String(b.reason || '').trim(), n = Date.now();
  if (reason.length < 5) bad('A reason is required for every edit (at least 5 characters).');
  const inMs = toMs(b.in_date || a.date, b.in_time);
  if (!inMs) bad('Enter a valid check-in time.');
  let outMs = null;
  if (b.out_time) { outMs = toMs(b.out_date || a.date, b.out_time); if (!outMs || outMs <= inMs) bad('Check-out must be after check-in.'); }
  else if (a.check_out) bad('A closed session needs a check-out time.');
  if (inMs > n || (outMs && outMs > n)) bad('Times cannot be in the future.');
  if (await overlaps(t, a.user_id, inMs, outMs, a.id)) bad('This overlaps another session for the same person.');
  await t.run("update attendance set check_in=?, check_out=?, date=?, source='admin_edit' where id=?", [inMs, outMs, dateOf(inMs), a.id]);
  if (outMs && !a.check_out) await closeOpenBreaks(t, a.id, outMs);
  await audit(t, req.user.id, 'attendance_edit', { id: a.id, user_id: a.user_id, reason, before: { in: a.check_in, out: a.check_out }, after: { in: inMs, out: outMs } });
  return { message: 'Attendance record updated' };
})));

/* ---------- admin: correction requests ---------- */
app.get('/api/admin/corrections', guard('admin'), h(req => {
  const st = req.query.status;
  return db.all(corrQuery + (st ? ' where c.status=?' : '') + " order by (c.status='pending') desc, c.id desc limit 200", st ? [st] : []);
}));
async function applyCorrection(t, r) {
  const n = Date.now();
  if (r.type === 'missed_checkin') {
    if (await overlaps(t, r.user_id, r.in_ms, r.out_ms, 0)) bad('Cannot approve: this overlaps an existing session for that person.', 409);
    await t.run("insert into attendance(user_id,date,check_in,check_out,source,created_at) values(?,?,?,?,'correction',?)",
      [r.user_id, dateOf(r.in_ms), r.in_ms, r.out_ms, n]);
  } else if (r.type === 'missed_checkout') {
    const a = await t.get('select * from attendance where id=?', [r.attendance_id]);
    if (!a || a.check_out) bad('Cannot approve: that session is no longer open.', 409);
    if (r.out_ms <= a.check_in) bad('Cannot approve: leaving time is before check-in.', 409);
    if (await overlaps(t, a.user_id, a.check_in, r.out_ms, a.id)) bad('Cannot approve: this overlaps another session.', 409);
    await t.run("update attendance set check_out=?, source='correction' where id=?", [r.out_ms, a.id]);
    await closeOpenBreaks(t, a.id, r.out_ms);
  } else if (r.type === 'correction') {
    const a = await t.get('select * from attendance where id=?', [r.attendance_id]);
    if (!a) bad('Cannot approve: record no longer exists.', 409);
    const inMs = r.in_ms || a.check_in, outMs = r.out_ms || a.check_out;
    if (outMs && outMs <= inMs) bad('Cannot approve: check-out would be before check-in.', 409);
    if (await overlaps(t, a.user_id, inMs, outMs, a.id)) bad('Cannot approve: this overlaps another session.', 409);
    await t.run("update attendance set check_in=?, check_out=?, date=?, source='correction' where id=?", [inMs, outMs, dateOf(inMs), a.id]);
    if (outMs && !a.check_out) await closeOpenBreaks(t, a.id, outMs);
  }
}
app.post('/api/admin/corrections/:id/decide', guard('admin'), h(req => tx(async t => {
  const r = await t.get('select * from corrections where id=? for update', [Number(req.params.id) || 0]);
  if (!r) bad('Not found', 404);
  if (r.status !== 'pending') bad('This request was already decided.', 409);
  const approve = req.body.decision === 'approve', note = String(req.body.note || '').trim();
  if (!approve && req.body.decision !== 'reject') bad('Invalid decision');
  if (!approve && !note) bad('Please add a note explaining the rejection.');
  if (approve) await applyCorrection(t, r);
  await t.run('update corrections set status=?, admin_note=?, decided_by=?, decided_at=? where id=?',
    [approve ? 'approved' : 'rejected', note, req.user.id, Date.now(), r.id]);
  await audit(t, req.user.id, 'correction_' + (approve ? 'approve' : 'reject'), { id: r.id, user_id: r.user_id, type: r.type, note });
  return { message: approve ? 'Request approved and attendance updated' : 'Request rejected' };
})));

/* ---------- settings ---------- */
app.get('/api/admin/settings', guard('admin'), h(() => cfg()));
app.put('/api/admin/settings', guard('admin'), h(async req => {
  const b = req.body, c = await cfg(), hm = /^\d\d:\d\d$/;
  if (!hm.test(b.office_start) || !hm.test(b.office_end) || b.office_start >= b.office_end) bad('Enter valid office start and end times (start must be before end).');
  const grace = Number(b.grace_minutes);
  if (!Number.isInteger(grace) || grace < 0 || grace > 120) bad('Grace period must be 0-120 minutes.');
  const breaks = {};
  for (const k of Object.keys(c.breaks)) {
    const x = (b.breaks || {})[k] || {}, max = Number(x.max_minutes);
    if (!Number.isInteger(max) || max < 1 || max > 600) bad(`Maximum for ${c.breaks[k].label} must be 1-600 minutes.`);
    breaks[k] = { label: c.breaks[k].label, paid: !!x.paid, max_minutes: max };
  }
  const next = { office_start: b.office_start, office_end: b.office_end, grace_minutes: grace, breaks };
  await db.run("update settings set value=? where key='config'", [JSON.stringify(next)]);
  await audit(db, req.user.id, 'settings_update', next);
  return { message: 'Policies saved' };
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  if (isDup(err)) return res.status(409).json({ error: 'That was already done. Refresh the page and check.' });
  if (retryable(err) || ['ECONNREFUSED', 'ENOTFOUND'].includes(err.code) || /timeout|Connection terminated/i.test(err.message || ''))
    return res.status(503).json({ error: 'The database is waking up. Wait a few seconds and try again.' });
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server.' });
});
function retryable(e) { return e && (/terminated|ECONNRESET|EPIPE/i.test(e.message) || ['ECONNRESET', 'EPIPE', '57P01'].includes(e.code)); }

const port = process.env.PORT || 3000;
init().then(async () => {
  sessionKey = process.env.SESSION_SECRET || (await db.get("select value from settings where key='session_secret'")).value;
  app.listen(port, () => console.log(`Attendance system running on http://localhost:${port}`));
}).catch(e => { console.error('Could not start. Database problem:', e.message); process.exit(1); });
