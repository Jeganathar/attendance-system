const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

types.setTypeParser(20, v => Number(v));   // bigint -> number (all our timestamps are epoch ms)
types.setTypeParser(1700, v => Number(v));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('\nDATABASE_URL is not set.\nPaste your Neon connection string into the DATABASE_URL environment variable (see README).\n');
  process.exit(1);
}
const local = /@(localhost|127\.0\.0\.1)/.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: true },
  max: 5,
  idleTimeoutMillis: 20000,        // close idle connections before Neon suspends compute
  connectionTimeoutMillis: 25000   // allow for a cold database wake-up
});
pool.on('error', e => console.error('Idle database connection error (safe to ignore):', e.message));

const conv = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
const retryable = e => e && (/terminated|ECONNRESET|ETIMEDOUT|EPIPE/i.test(e.message) || ['ECONNRESET', 'EPIPE', '57P01'].includes(e.code));
const mk = (ex, canRetry) => {
  const q = async (s, p = []) => {
    try { return await ex.query(conv(s), p); }
    catch (e) { if (canRetry && retryable(e)) return ex.query(conv(s), p); throw e; }
  };
  return {
    all: async (s, p) => (await q(s, p)).rows,
    get: async (s, p) => (await q(s, p)).rows[0],
    run: async (s, p) => { const r = await q(s, p); return { changes: r.rowCount, id: r.rows[0] && r.rows[0].id }; },
    exec: async s => ex.query(s)
  };
};
const db = mk(pool, true);
async function tx(fn) {
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const r = await fn(mk(cl, false));
    await cl.query('COMMIT');
    return r;
  } catch (e) { try { await cl.query('ROLLBACK'); } catch { } throw e; }
  finally { cl.release(); }
}

const DEFAULT_CONFIG = {
  office_start: '09:30', office_end: '18:30', grace_minutes: 10,
  breaks: {
    tea: { label: 'Tea Break', paid: false, max_minutes: 15 },
    lunch: { label: 'Lunch', paid: false, max_minutes: 60 },
    personal: { label: 'Personal Break', paid: false, max_minutes: 15 }
  }
};

// All timestamps are epoch milliseconds (UTC). "date" columns hold the IST calendar date (YYYY-MM-DD).
async function init() {
  await db.exec(`
create table if not exists users(
  id serial primary key, name text not null, email text not null unique,
  password_hash text not null, role text not null check(role in ('admin','staff')),
  department text default '', active integer not null default 1, created_at bigint not null);
create table if not exists attendance(
  id serial primary key, user_id integer not null references users(id), date text not null,
  check_in bigint not null, check_out bigint, source text not null default 'self', created_at bigint not null);
create index if not exists ix_att_user_date on attendance(user_id, date);
create index if not exists ix_att_date on attendance(date);
create unique index if not exists ux_one_open_session on attendance(user_id) where check_out is null;
create table if not exists breaks(
  id serial primary key, attendance_id integer not null references attendance(id) on delete cascade,
  user_id integer not null, type text not null, start_ms bigint not null, end_ms bigint);
create index if not exists ix_breaks_att on breaks(attendance_id);
create unique index if not exists ux_one_open_break on breaks(user_id) where end_ms is null;
create table if not exists corrections(
  id serial primary key, user_id integer not null references users(id), type text not null,
  attendance_id integer, in_ms bigint, out_ms bigint, reason text not null,
  status text not null default 'pending', admin_note text default '', decided_by integer,
  decided_at bigint, created_at bigint not null);
create table if not exists settings(key text primary key, value text not null);
create table if not exists audit_log(
  id serial primary key, actor_id integer, action text not null, details text, created_at bigint not null);
`);
  await db.run("insert into settings(key,value) values('config',?) on conflict do nothing", [JSON.stringify(DEFAULT_CONFIG)]);
  await db.run("insert into settings(key,value) values('session_secret',?) on conflict do nothing", [crypto.randomBytes(32).toString('hex')]);
  if (!(await db.get('select 1 as x from users limit 1'))) {
    const ins = 'insert into users(name,email,password_hash,role,department,created_at) values(?,?,?,?,?,?) on conflict do nothing';
    await db.run(ins, ['Administrator', 'admin@neurogen.ai', bcrypt.hashSync('Admin@123', 10), 'admin', 'Management', Date.now()]);
    await db.run(ins, ['Demo Staff', 'staff@neurogen.ai', bcrypt.hashSync('Staff@123', 10), 'staff', 'Training', Date.now()]);
    console.log('Created first accounts: admin@neurogen.ai / Admin@123 and staff@neurogen.ai / Staff@123 -- change these passwords!');
  }
}

module.exports = { db, tx, init, pool };
