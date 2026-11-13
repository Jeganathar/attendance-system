let filter = 'all', TODAY = null, USERS = [], editUser = null, editAtt = null, POL = null;
const TYPES = { missed_checkin: 'Missed check-in', missed_checkout: 'Missed check-out', correction: 'Time correction' };
startClock($('#clock'));

const loaders = { today: loadToday, staff: loadStaff, attendance: loadAtt, requests: loadReq, policies: loadPol };
let tab = 'today';
function show(t) { tab = t;
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $$('.panel').forEach(p => p.hidden = p.id !== 'p-' + t);
  run(loaders[t]); }
$$('.tab').forEach(b => b.onclick = () => show(b.dataset.t));

/* ---- today ---- */
const CARDS = [['all', 'total', 'All staff'], ['working', 'working', 'Working now'], ['on_break', 'on_break', 'On break'], ['not_in', 'not_in', 'Not logged in'],
  ['forgot_logout', 'forgot_logout', 'Forgot to log out'], ['checked_out', 'checked_out', 'Left for the day'], ['late', 'late', 'Late today']];
async function loadToday() {
  TODAY = await api('/admin/today'); renderToday();
  const p = await api('/admin/corrections?status=pending'); const n = $('#pendN'); n.hidden = !p.length; n.textContent = p.length;
}
function renderToday() {
  $('#cards').innerHTML = CARDS.map(([f, k, l]) => `<button class="stat ${filter === f ? 'on' : ''}" data-f="${f}"><b>${TODAY.counts[k]}</b><span>${l}</span></button>`).join('');
  const rows = TODAY.staff.filter(s => filter === 'all' || (filter === 'late' ? s.late : s.status === filter));
  $('#tToday').innerHTML = rows.map(s => `<tr><td><b>${esc(s.name)}</b><div class="small mute">${esc(s.department)}</div></td>
    <td><span class="badge ${s.status}">${STATUS[s.status]}</span>${s.break_type ? `<div class="small mute">${esc(s.break_type)} since ${fmtT(s.break_since)}</div>` : ''}</td>
    <td>${fmtT(s.first_in)}</td><td>${s.last_out ? fmtT(s.last_out) : s.status === 'not_in' ? '-' : 'still in'}</td><td>${fmtDur(s.break_min)}</td><td><b>${fmtDur(s.net_min)}</b></td>
    <td>${flagsHtml(s)}${s.warnings.map(w => `<div class="small" style="color:var(--bad)">${esc(w)}</div>`).join('')}</td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">No staff match this filter.</td></tr>';
}
$('#cards').onclick = e => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; renderToday(); } };

/* ---- staff ---- */
async function loadStaff() {
  USERS = await api('/admin/users');
  $('#tUsers').innerHTML = USERS.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.department)}</td><td>${u.role}</td>
    <td><span class="badge ${u.active ? 'working' : 'not_in'}">${u.active ? 'Active' : 'Inactive'}</span></td>
    <td class="row"><button class="sm" data-e="${u.id}">Edit</button><button class="sm danger" data-d="${u.id}">${u.active ? 'Deactivate' : 'Delete'}</button></td></tr>`).join('');
}
function openUser(u) {
  editUser = u; $('#dUserT').textContent = u ? 'Edit staff' : 'Add staff';
  $('#uName').value = u?.name || ''; $('#uEmail').value = u?.email || ''; $('#uDept').value = u?.department || '';
  $('#uRole').value = u?.role || 'staff'; $('#uPw').value = ''; $('#uActive').checked = u ? !!u.active : true; $('#uActive').disabled = !u;
  $('#uPwL').textContent = u ? 'New password (leave blank to keep)' : 'Password (at least 8 characters)'; $('#dUser').showModal();
}
$('#addU').onclick = () => openUser(null);
$('#uCancel').onclick = () => $('#dUser').close();
$('#uSave').onclick = () => run(async () => {
  const body = { name: $('#uName').value, email: $('#uEmail').value, department: $('#uDept').value, role: $('#uRole').value, password: $('#uPw').value };
  if (editUser) { body.active = $('#uActive').checked; toast((await put('/admin/users/' + editUser.id, body)).message); }
  else toast((await post('/admin/users', body)).message);
  $('#dUser').close(); loadStaff();
});
$('#tUsers').onclick = e => { const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.e) openUser(USERS.find(u => u.id == b.dataset.e));
  if (b.dataset.d) { const u = USERS.find(x => x.id == b.dataset.d);
    run(async () => {
      if (u.active) { if (confirm(`Deactivate ${u.name}? They will no longer be able to sign in. History is kept.`)) toast((await api('/admin/users/' + u.id, { method: 'DELETE' })).message); }
      else if (confirm(`Permanently delete ${u.name}? This only works for accounts with no attendance history.`)) toast((await api('/admin/users/' + u.id + '?hard=1', { method: 'DELETE' })).message);
      loadStaff(); }); } };

/* ---- attendance ---- */
$('#aTo').value = ymd(Date.now()); $('#aFrom').value = ymd(Date.now() - 6 * 86400000);
async function loadAtt() {
  if (!$('#aUser').options.length) {
    USERS = await api('/admin/users');
    $('#aUser').innerHTML = '<option value="">All staff</option>' + USERS.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  }
  const d = await api(`/admin/attendance?from=${$('#aFrom').value}&to=${$('#aTo').value}&user_id=${$('#aUser').value}`);
  window.ATT = d.records; $('#aTotal').textContent = `Total net hours: ${fmtDur(d.total_net_min)}`;
  $('#tAtt').innerHTML = d.records.map(r => `<tr><td>${fmtD(r.date)}</td><td>${esc(r.user_name)}${r.source !== 'self' ? `<div class="small mute">${r.source === 'admin_edit' ? 'edited by admin' : 'via correction'}</div>` : ''}</td>
    <td>${fmtT(r.check_in)}</td><td>${r.check_out ? fmtT(r.check_out) : '<span class="flag warn">open</span>'}</td><td>${fmtDur(r.break_min)}</td><td><b>${fmtDur(r.net_min)}</b></td>
    <td>${flagsHtml(r)}</td><td><button class="sm" data-a="${r.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No records for this selection.</td></tr>';
}
$('#aGo').onclick = () => run(loadAtt);
$('#tAtt').onclick = e => { const b = e.target.closest('[data-a]'); if (!b) return;
  editAtt = window.ATT.find(r => r.id == b.dataset.a);
  $('#dAttInfo').textContent = `${editAtt.user_name}, ${fmtD(editAtt.date)}`;
  $('#eIn').value = hm(editAtt.check_in); $('#eOut').value = hm(editAtt.check_out); $('#eOutD').value = editAtt.check_out ? ymd(editAtt.check_out) : editAtt.date; $('#eWhy').value = '';
  $('#dAtt').showModal(); };
$('#eCancel').onclick = () => $('#dAtt').close();
$('#eSave').onclick = () => run(async () => {
  toast((await put('/admin/attendance/' + editAtt.id, { in_time: $('#eIn').value, out_time: $('#eOut').value, out_date: $('#eOutD').value, reason: $('#eWhy').value })).message);
  $('#dAtt').close(); loadAtt(); });

/* ---- requests ---- */
function detail(r) {
  if (r.type === 'missed_checkin') return `Arrived ${fmtD(ymd(r.in_ms))} at ${fmtT(r.in_ms)}${r.out_ms ? `, left ${fmtT(r.out_ms)}` : ' (no leaving time given)'}`;
  if (r.type === 'missed_checkout') return `Left ${fmtD(ymd(r.out_ms))} at ${fmtT(r.out_ms)} (session started ${fmtD(r.att_date)} ${fmtT(r.att_in)})`;
  return `${fmtD(r.att_date)}: now ${fmtT(r.att_in)} - ${r.att_out ? fmtT(r.att_out) : 'open'}; requested ${r.in_ms ? fmtT(r.in_ms) : 'unchanged'} - ${r.out_ms ? fmtT(r.out_ms) : 'unchanged'}`;
}
async function loadReq() {
  const list = await api('/admin/corrections'), pend = list.filter(r => r.status === 'pending'), done = list.filter(r => r.status !== 'pending');
  const n = $('#pendN'); n.hidden = !pend.length; n.textContent = pend.length;
  $('#reqList').innerHTML = `<h2>Pending (${pend.length})</h2>` + (pend.map(r => `<div class="card" data-r="${r.id}">
    <div class="row"><b>${esc(r.user_name)}</b><span class="badge pending">${TYPES[r.type]}</span><span class="mute small">sent ${new Date(r.created_at).toLocaleString('en-IN', { timeZone: TZ })}</span></div>
    <p style="margin:.4rem 0">${esc(detail(r))}</p><p class="mute" style="margin:0 0 .6rem">Reason: ${esc(r.reason)}</p>
    <div class="row"><input placeholder="Note (required to reject)" style="flex:1;min-width:200px" data-note>
    <button class="primary sm" data-x="approve">Approve</button><button class="sm danger" data-x="reject">Reject</button></div></div>`).join('') || '<div class="card empty">No pending requests.</div>')
    + `<h2>Recent decisions</h2><div class="card scroll"><table><thead><tr><th>Staff</th><th>Request</th><th>Decision</th><th>Note</th></tr></thead><tbody>${done.map(r => `<tr><td>${esc(r.user_name)}</td><td>${TYPES[r.type]}<div class="small mute">${esc(detail(r))}</div></td><td><span class="badge ${r.status}">${r.status}</span></td><td>${esc(r.admin_note)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing decided yet.</td></tr>'}</tbody></table></div>`;
}
$('#reqList').onclick = e => { const b = e.target.closest('[data-x]'); if (!b) return;
  const card = b.closest('[data-r]');
  run(async () => { toast((await post(`/admin/corrections/${card.dataset.r}/decide`, { decision: b.dataset.x, note: $('[data-note]', card).value })).message); loadReq(); }); };

/* ---- policies ---- */
async function loadPol() {
  POL = await api('/admin/settings');
  $('#oStart').value = POL.office_start; $('#oEnd').value = POL.office_end; $('#oGrace').value = POL.grace_minutes;
  $('#tPol').innerHTML = Object.entries(POL.breaks).map(([k, b]) => `<tr><td>${esc(b.label)}</td><td><label style="margin:0;color:var(--ink)"><input type="checkbox" data-paid="${k}" ${b.paid ? 'checked' : ''}> Paid</label></td><td><input type="number" min="1" max="600" data-max="${k}" value="${b.max_minutes}" style="max-width:120px"></td></tr>`).join('');
}
$('#polSave').onclick = () => run(async () => {
  const breaks = {}; for (const k of Object.keys(POL.breaks)) breaks[k] = { paid: $(`[data-paid=${k}]`).checked, max_minutes: Number($(`[data-max=${k}]`).value) };
  toast((await put('/admin/settings', { office_start: $('#oStart').value, office_end: $('#oEnd').value, grace_minutes: Number($('#oGrace').value), breaks })).message);
  loadPol(); });

show('today');
setInterval(() => { if (tab === 'today' && !document.hidden) loadToday().catch(() => {}); }, 30000);
