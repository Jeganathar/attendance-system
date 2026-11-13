let S = null;
const TYPES = { missed_checkin: 'Missed check-in', missed_checkout: 'Missed check-out', correction: 'Time correction' };
startClock($('#clock'));

$$('.tab').forEach(b => b.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('on', x === b));
  $$('.panel').forEach(p => p.hidden = p.id !== 'p-' + b.dataset.t);
  if (b.dataset.t === 'history') loadHistory();
  if (b.dataset.t === 'requests') loadRequests();
});

async function load() {
  S = await api('/staff/state');
  $('#who').textContent = S.user.name;
  const w = [...S.warnings];
  if (S.stale) w.unshift(`You have an unclosed session from ${fmtD(S.stale.date)} (checked in ${fmtT(S.stale.check_in)}). Go to Corrections and send a missed check-out request.`);
  $('#warn').innerHTML = w.map(x => `<div class="alert" role="alert">${esc(x)}</div>`).join('');
  const st = S.status;
  $('#badge').className = 'badge ' + st; $('#badge').textContent = STATUS[st];
  $('#detail').textContent = st === 'working' ? `Checked in at ${fmtT(S.open.check_in)}`
    : st === 'on_break' ? `${S.config.breaks[S.open_break.type]?.label} since ${fmtT(S.open_break.start_ms)}`
    : st === 'checked_out' ? 'You can check in again if you return to the office.'
    : st === 'forgot_logout' ? 'Check-in is blocked until the missed check-out is approved.' : 'Tap CHECK IN when you arrive.';
  $('#bIn').disabled = !(st === 'not_in' || st === 'checked_out');
  $('#bOut').disabled = st !== 'working';
  $('#brk').innerHTML = Object.entries(S.config.breaks).map(([k, b]) => `
    <button data-b="start" data-k="${k}" ${st !== 'working' ? 'disabled' : ''}>${esc(b.label)} start</button>
    <button data-b="end" data-k="${k}" ${st === 'on_break' && S.open_break.type === k ? '' : 'disabled'}>${esc(b.label)} end</button>`).join('');
  $('#brkNote').textContent = 'One break at a time. ' + Object.values(S.config.breaks).map(b => `${b.label}: max ${b.max_minutes}m, ${b.paid ? 'paid' : 'unpaid'}`).join('; ') + '.';
  $('#sGross').textContent = fmtDur(S.totals.gross_min); $('#sBrk').textContent = fmtDur(S.totals.break_min); $('#sNet').textContent = fmtDur(S.totals.net_min);
  const rows = [];
  for (const s of S.sessions) {
    rows.push(`<tr><td>Check in</td><td>${fmtT(s.check_in)}</td><td></td></tr>`);
    for (const b of s.breaks) rows.push(`<tr><td>${esc(S.config.breaks[b.type]?.label || b.type)}</td><td>${fmtT(b.start_ms)} - ${b.end_ms ? fmtT(b.end_ms) : 'running'}</td><td>${fmtDur(((b.end_ms || S.now) - b.start_ms) / 60000)}</td></tr>`);
    rows.push(`<tr><td>Check out</td><td>${s.check_out ? fmtT(s.check_out) : '-'}</td><td>${s.check_out ? fmtDur(s.gross_min) + ' in office' : 'in office'}</td></tr>`);
  }
  $('#log').innerHTML = rows.join('') || '<tr><td colspan="3" class="empty">Nothing recorded yet today.</td></tr>';
}
const doAct = (path, body) => run(async () => { toast((await post(path, body)).message); await load(); });
$('#bIn').onclick = () => doAct('/staff/checkin');
$('#bOut').onclick = () => { if (confirm('Check out now?')) doAct('/staff/checkout'); };
$('#brk').onclick = e => { const b = e.target.closest('button'); if (!b || b.disabled) return;
  b.dataset.b === 'start' ? doAct('/staff/break/start', { type: b.dataset.k }) : doAct('/staff/break/end'); };

/* history */
const mnow = new Date(Date.now() + 19800000).toISOString().slice(0, 7);
$('#month').value = mnow; $('#month').onchange = () => loadHistory();
async function loadHistory() { run(async () => {
  const m = $('#month').value || mnow, [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const h = await api(`/staff/history?from=${m}-01&to=${m}-${String(last).padStart(2, '0')}`);
  $('#hDays').textContent = h.days_present; $('#hNet').textContent = fmtDur(h.total_net_min); $('#hBrk').textContent = fmtDur(h.total_break_min);
  $('#hist').innerHTML = h.days.map(d => `<tr><td>${fmtD(d.date)}${d.sessions > 1 ? ` <span class="mute small">(${d.sessions} sessions)</span>` : ''}</td><td>${fmtT(d.first_in)}</td><td>${d.last_out ? fmtT(d.last_out) : 'open'}</td><td>${fmtDur(d.break_min)}</td><td><b>${fmtDur(d.net_min)}</b></td><td>${flagsHtml(d)}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">No attendance recorded this month.</td></tr>';
}); }

/* corrections */
const typeUI = () => {
  const t = $('#rType').value;
  $('#fAtt').hidden = t !== 'correction'; $('#fIn').hidden = t === 'missed_checkout';
  $('#lDate').textContent = t === 'missed_checkout' ? 'Actual leaving date' : 'Actual arrival date';
  $('#fDate').hidden = t === 'correction';
  $('#lIn').textContent = t === 'correction' ? 'Correct check-in time (leave blank to keep)' : 'Actual arrival time (IST)';
  $('#lOut').textContent = t === 'missed_checkout' ? 'Actual leaving time (IST)' : t === 'correction' ? 'Correct check-out time (leave blank to keep)' : 'Actual leaving time (IST), if you already left';
  $('#rHint').textContent = t === 'missed_checkout' ? (S?.open ? `Applies to your open session from ${fmtD(S.open.date)} (checked in ${fmtT(S.open.check_in)}).` : 'You have no open session to close.') : '';
  if (t === 'missed_checkout' && S?.open && !$('#rDate').value) $('#rDate').value = S.open.date;
};
$('#rType').onchange = typeUI;
async function loadRequests() { run(async () => {
  await load(); typeUI();
  const to = ymd(Date.now()), from = ymd(Date.now() - 45 * 86400000);
  const h = await api(`/staff/history?from=${from}&to=${to}`);
  $('#rAtt').innerHTML = h.days.flatMap(d => d.records).map(r => `<option value="${r.id}">${fmtD(r.date)}: ${fmtT(r.check_in)} - ${r.check_out ? fmtT(r.check_out) : 'open'}</option>`).join('') || '<option value="">No records in the last 45 days</option>';
  const list = await api('/staff/corrections');
  $('#reqs').innerHTML = list.map(r => `<tr><td>${new Date(r.created_at).toLocaleDateString('en-IN', { timeZone: TZ })}</td><td>${TYPES[r.type]}<div class="small mute">${esc(describe(r))}</div></td><td><span class="badge ${r.status}">${r.status}</span></td><td>${esc(r.admin_note)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">No requests yet.</td></tr>';
}); }
function describe(r) {
  const p = [];
  if (r.in_ms) p.push('in ' + fmtD(ymd(r.in_ms)) + ' ' + fmtT(r.in_ms));
  if (r.out_ms) p.push('out ' + fmtD(ymd(r.out_ms)) + ' ' + fmtT(r.out_ms));
  return p.join(', ') + ' - ' + r.reason;
}
$('#rSend').onclick = () => run(async () => {
  const body = { type: $('#rType').value, date: $('#rDate').value, in_time: $('#rIn').value, out_time: $('#rOut').value, attendance_id: $('#rAtt').value, reason: $('#rWhy').value };
  toast((await post('/staff/corrections', body)).message);
  ['#rIn', '#rOut', '#rWhy'].forEach(s => $(s).value = '');
  loadRequests();
});

load().catch(e => toast(e.message, true));
setInterval(() => { if (!$('#p-today').hidden) load().catch(() => {}); }, 30000);
