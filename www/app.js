'use strict';
/* Employee app. Talks to the Google Apps Script web app. All licence / time / duplicate decisions are made there. */
const $app = document.getElementById('app');
const showFatal = (m) => { if (!$app.innerHTML.trim()) $app.innerHTML = '<div class="card"><div class="banner bad">App error: ' + String(m).replace(/[<>&]/g, '') + '<br>Please install the latest APK or contact your administrator.</div></div>'; };
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason && e.reason.message || e.reason));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const serverUrl = () => (store.get('server_url') || window.APP_CONFIG.SERVER_URL).trim();
const APP_VERSION = '2.5';
const cap = window.Capacitor;
const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
// Talks to the native Camera / Geolocation plugins through the Capacitor bridge that Android injects into the page
// (cap.nativePromise / cap.nativeCallback). This needs no bundler and no extra script files.
const plugin = (name) => {
  if (!isNative || !cap.nativePromise || !cap.nativeCallback) return null;
  return new Proxy({}, { get: (_, m) => {
    if (m === 'then') return undefined;
    if (m === 'watchPosition') return (opts, cb) => Promise.resolve(cap.nativeCallback(name, m, opts || {}, cb));   // resolves to a watch id
    return (opts) => cap.nativePromise(name, m, opts || {});
  } });
};

let state = { me: null, offset: 0, timer: null, poll: null };

class ApiError extends Error { constructor(m, code, data) { super(m); this.code = code; this.data = data; } }
async function call(action, payload = {}) {
  let res;
  try {
    res = await fetch(serverUrl(), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, id: store.get('eid'), pin: store.get('pin'), ...payload }) });
  } catch { throw new ApiError('Cannot reach the server. Check your internet connection. Nothing was recorded.', 'NETWORK'); }
  let data; try { data = await res.json(); } catch { throw new ApiError('Unexpected reply from the server. Check the server address in the app build.', 'BAD_REPLY'); }
  if (data.server_time) state.offset = new Date(data.server_time) - Date.now();
  if (data.ok) return data;
  if (/^(AUTH_|LICENCE_)/.test(data.error || '') && action !== 'login') { store.del('pin'); stopTimers(); showLogin(data.message); }
  throw new ApiError(data.message || 'Request failed', data.error, data);
}
const serverNow = () => new Date(Date.now() + state.offset);
const fmtDate = (d) => { const [y, m, dd] = String(d).split('-'); return `${dd}/${m}/${y}`; };
const dur = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return String(Math.floor(m / 60)).padStart(2, '0') + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
const mapLink = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;
function stopTimers() { clearInterval(state.timer); clearInterval(state.poll); }

function showLogin(msg) {
  stopTimers(); document.getElementById('who').textContent = '';
  $app.innerHTML = `<div class="card"><h2 style="margin:0 0 4px">Sign in</h2><div class="small">Field Engineer Attendance</div>
    ${msg ? `<div class="banner bad" style="margin-top:12px">${esc(msg)}</div>` : ''}
    <label>Employee ID</label><input id="u" autocapitalize="characters" autocomplete="username" value="${esc(store.get('eid') || '')}">
    <label>PIN</label><input id="p" type="password" inputmode="numeric" autocomplete="current-password">
    <button id="go">Sign in</button><div id="err" class="banner bad hidden" style="margin-top:12px"></div></div>`;
  document.getElementById('go').onclick = async () => {
    const b = document.getElementById('go'), err = document.getElementById('err'); b.disabled = true; err.classList.add('hidden');
    store.set('eid', document.getElementById('u').value.trim().toUpperCase()); store.set('pin', document.getElementById('p').value.trim());
    try { await call('login'); loadHome(); }
    catch (e) { store.del('pin'); err.textContent = e.message; err.classList.remove('hidden'); b.disabled = false; }
  };
}
async function loadHome() {
  try { state.me = await call('me'); } catch (e) { if (e.code === 'NETWORK' || e.code === 'BAD_REPLY') return showOffline(e.message); return; }
  clearInterval(state.poll); state.poll = setInterval(refreshMe, 60000); renderHome();
}
async function refreshMe() { try { state.me = await call('me'); renderHome(); } catch {} }
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.get('pin')) refreshMe(); });
function showOffline(m) { $app.innerHTML = `<div class="card"><div class="banner bad">${esc(m)}</div><button id="rt">Retry</button></div>`; document.getElementById('rt').onclick = loadHome; }

function renderHome() {
  const { employee: e, licence: l, open_session: o, last_session: last } = state.me;
  document.getElementById('who').textContent = e.id;
  let action = '', status = '';
  if (o) {
    status = `<div class="banner ok">Checked in at <b>${esc(o.in_time)}</b> — ${esc(o.site || '')}</div><div class="timer" id="tm"></div>`;
    action = `<button class="red big" id="out">LOG OUT / CHECK OUT</button>`;
  } else if (last && last.out_time) {
    status = `<div class="banner ok">Today: ${esc(last.in_time)} → ${esc(last.out_time)} (${esc(last.duration || '')})</div>`;
    action = `<button class="green big" id="in">MARK ATTENDANCE AGAIN</button>`;
  } else { status = `<div class="banner warn">Attendance not marked today.</div>`; action = `<button class="green big" id="in">MARK ATTENDANCE</button>`; }
  $app.innerHTML = `<div class="card"><div style="font-size:20px;font-weight:700">${esc(e.name)}</div>
    <div class="row"><span>Designation</span><span>${esc(e.designation || '—')}</span></div>
    <div class="row"><span>Site</span><span>${esc(e.site || '—')}</span></div></div>
    <div class="banner ${l.state === 'trial' ? 'warn' : 'ok'}">${esc(l.message)}</div>${status}${action}
    <button class="ghost" id="hs">Attendance history</button><button class="ghost" id="lo">Sign out</button>
    <div class="small" style="margin-top:12px;text-align:center">Your photo and GPS location are recorded at check-in, and GPS location at check-out, for attendance purposes only.</div>
    <div class="small" style="margin-top:8px;text-align:center">App v${APP_VERSION} · ${isNative ? 'phone app' : 'browser'}</div>`;
  if (o) { const tick = () => { document.getElementById('tm').textContent = dur(serverNow() - new Date(o.in_ts)); }; tick(); clearInterval(state.timer); state.timer = setInterval(tick, 20000); }
  const g = (id) => document.getElementById(id);
  if (g('in')) g('in').onclick = startCheckIn; if (g('out')) g('out').onclick = doCheckOut;
  g('hs').onclick = showHistory; g('lo').onclick = () => { store.del('pin'); showLogin(); };
}

// Collects GPS readings for up to 15 s and keeps the most accurate one. Any accuracy is accepted and recorded.
async function getLocation() {
  const G = plugin('Geolocation');
  if (isNative && !G) throw new Error('GPS component is missing in this app build. Please install the latest APK.');
  const pack = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, loc_age_s: Math.max(0, (Date.now() - p.timestamp) / 1000) });
  const WAIT_MS = 12000, GOOD_M = 25, EARLY_MS = 5000, EARLY_M = 50, t0 = Date.now();
  try {
    if (G) {
      const perm = await G.checkPermissions();
      if (perm.location !== 'granted') { const r = await G.requestPermissions(); if (r.location !== 'granted') throw new Error('Location permission is denied. Enable it in Settings > Apps > VATS Attendance > Permissions > Location.'); }
    }
    return await new Promise((resolve, reject) => {
      let best = null, done = false, id = null, timer = null;
      const stop = async () => { try { if (id !== null) { if (G) await G.clearWatch({ id }); else navigator.geolocation.clearWatch(id); } } catch {} };
      const finish = (err) => { if (done) return; done = true; clearTimeout(timer); stop(); best ? resolve(pack(best)) : reject(err || new Error('No GPS fix received')); };
      timer = setTimeout(() => finish(), WAIT_MS); setTimeout(() => { if (!done && best && best.coords.accuracy <= EARLY_M) finish(); }, EARLY_MS);
      const onPos = (pos, err) => {
        if (done) return;
        if (err || !pos) { if (!best) finish(err instanceof Error ? err : new Error((err && err.message) || 'GPS error')); return; }
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        if (best.coords.accuracy <= GOOD_M || (Date.now() - t0 >= EARLY_MS && best.coords.accuracy <= EARLY_M)) finish();
      };
      const start = G
        ? G.watchPosition({ enableHighAccuracy: true, timeout: WAIT_MS, maximumAge: 0 }, onPos)
        : Promise.resolve(navigator.geolocation.watchPosition((p) => onPos(p), (e) => onPos(null, e), { enableHighAccuracy: true, timeout: WAIT_MS, maximumAge: 0 }));
      start.then((wid) => { id = wid; if (done) stop(); }).catch((e) => finish(e));
    });
  } catch (e) { throw new Error(/denied|permission/i.test(e.message) ? e.message : 'Could not get your location. Turn ON Location (GPS) on your phone and try again. ' + (e.message || '')); }
}
async function takePhoto() {   // returns a data URL (jpeg) or null if cancelled. Live camera only; gallery is never offered.
  const C = plugin('Camera');
  if (isNative && !C) throw new Error('Camera component is missing in this app build. Please install the latest APK.');
  if (C) {
    try {
      const perm = await C.checkPermissions(); if (perm.camera !== 'granted') { const r = await C.requestPermissions({ permissions: ['camera'] }); if (r.camera !== 'granted') throw new Error('Camera permission is denied. Enable it in Settings > Apps > VATS Attendance > Permissions.'); }
      const ph = await C.getPhoto({ quality: 60, width: 800, resultType: 'base64', source: 'CAMERA', direction: 'FRONT', correctOrientation: true, saveToGallery: false });
      return 'data:image/' + (ph.format === 'png' ? 'png' : 'jpeg') + ';base64,' + ph.base64String;
    } catch (e) { if (/cancel/i.test(e.message)) return null; throw e; }
  }
  return await new Promise((ok) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'user');
    i.onchange = () => { const f = i.files[0]; if (!f) return ok(null); const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); }; i.click(); });
}
// Resize to 800px wide and burn the information band into the picture before upload.
function stamp(dataUrl, lines) {
  return new Promise((ok, no) => {
    const img = new Image(); img.onerror = () => no(new Error('Could not read the photo. Please retake.'));
    img.onload = () => {
      const w = Math.min(800, img.width), h = Math.round(img.height * w / img.width), c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
      const fs = Math.max(Math.round(w / 34), 13), lh = Math.round(fs * 1.35), bh = lh * lines.length + 14;
      x.fillStyle = 'rgba(0,0,0,0.62)'; x.fillRect(0, h - bh, w, bh); x.fillStyle = '#fff'; x.font = fs + 'px sans-serif'; x.textBaseline = 'top';
      lines.forEach((t, i) => x.fillText(t, 10, h - bh + 8 + i * lh));
      ok(c.toDataURL('image/jpeg', 0.6));
    };
    img.src = dataUrl;
  });
}

let flow = null;   // one idempotency key per check-in attempt so retries never create duplicates
async function startCheckIn() {
  try {
    // Speed: start finding the location NOW, while the person is taking the photo (both happen at the same time).
    const key = flow && flow.key ? flow.key : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    const keep = flow && flow.loc && Date.now() - flow.locAt < 120000 ? flow : null;   // retake: reuse a fresh location
    flow = { raw: null, key, loc: keep ? keep.loc : null, locAt: keep ? keep.locAt : 0, busy: null, err: '' };
    const f = flow;
    if (!f.loc) { try { await ensureLocPermission(); acquireLocation(); } catch (e) { f.err = e.message; } }
    const p = await takePhoto();
    if (!p) { if (flow === f) flow = null; return; }
    f.raw = p; renderPreview();
  } catch (e) { alert(e.message); }
}
async function ensureLocPermission() {
  const G = plugin('Geolocation'); if (!G) return;
  const perm = await G.checkPermissions();
  if (perm.location !== 'granted') { const r = await G.requestPermissions(); if (r.location !== 'granted') throw new Error('Location permission is denied. Enable it in Settings > Apps > VATS Attendance > Permissions > Location.'); }
}
function acquireLocation() {
  const f = flow; if (!f) return Promise.resolve();
  if (f.busy) return f.busy;
  f.err = ''; f.loc = null; setLocStatus();
  f.busy = getLocation().then((l) => { f.loc = l; f.locAt = Date.now(); }).catch((e) => { f.err = e.message; }).finally(() => { f.busy = null; if (flow === f) setLocStatus(); });
  return f.busy;
}
function setLocStatus() {
  const el = document.getElementById('locst'); if (!el || !flow) return;
  if (flow.busy) el.innerHTML = '📍 Getting your location… (a few seconds)';
  else if (flow.loc) el.innerHTML = `📍 Location ready — accuracy about ${Math.round(flow.loc.accuracy)} m`;
  else el.innerHTML = `<span style="color:#c62828">📍 ${esc(flow.err || 'Location not received.')}</span> <a href="#" id="retryloc">Try again</a>`;
  const r = document.getElementById('retryloc'); if (r) r.onclick = (e) => { e.preventDefault(); acquireLocation(); };
}
function renderPreview(msg) {
  $app.innerHTML = `<div class="card"><h3 style="margin:0">Confirm your photo</h3><img class="thumb" src="${flow.raw}">
    <div id="locst" class="small" style="margin-top:10px;font-size:14px"></div>
    ${msg ? `<div class="banner bad" style="margin-top:12px">${esc(msg)}</div>` : ''}
    <button class="green" id="sub">Submit attendance</button><button class="ghost" id="rt">Retake photo</button><button class="ghost" id="cn">Cancel</button></div>`;
  document.getElementById('cn').onclick = () => { flow = null; renderHome(); };
  document.getElementById('rt').onclick = startCheckIn;
  setLocStatus();
  if (!flow.loc && !flow.busy) acquireLocation();
  document.getElementById('sub').onclick = async (ev) => {
    const b = ev.target; b.disabled = true;
    try {
      if (flow.loc && Date.now() - flow.locAt > 180000) flow.loc = null;       // location older than 3 minutes: take a new one
      if (!flow.loc) { b.textContent = 'Getting your location…'; await acquireLocation(); }
      if (!flow.loc) throw new Error(flow.err || 'Location not received. Turn ON Location (GPS) and try again.');
      b.textContent = 'Submitting…'; const loc = flow.loc;
      const e = state.me.employee, now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      const photo = await stamp(flow.raw, [`${e.name} (${e.id})`, `${e.designation || ''}${e.designation && e.site ? ' | ' : ''}${e.site || ''}`, now, `Lat ${loc.lat.toFixed(6)}  Long ${loc.lng.toFixed(6)}  (+/-${Math.round(loc.accuracy)} m)`].filter(Boolean));
      const r = await call('checkin', { ...loc, idem: flow.key, photo: photo.split(',')[1] });
      flow = null; showResult('Attendance recorded', r, photo);
    } catch (er) { const sb = document.getElementById('sub'); if (!sb) return;   // page already replaced (e.g. signed out)
      b.disabled = false; b.textContent = 'Submit attendance'; const m = document.querySelector('#app .banner.bad'); if (m) m.remove(); sb.insertAdjacentHTML('beforebegin', `<div class="banner bad" style="margin-top:12px">${esc(er.message)}</div>`); }
  };
}
async function doCheckOut() {
  if (!confirm('Log out of your attendance session now?')) return;
  const b = document.getElementById('out'); b.disabled = true; b.textContent = 'Getting your location…';
  try {
    const loc = await getLocation(); b.textContent = 'Submitting…';
    showResult('Logged out', await call('checkout', { ...loc, idem: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) }));
  } catch (e) { alert(e.message); b.disabled = false; b.textContent = 'LOG OUT / CHECK OUT'; }
}
function showResult(title, r, img) {
  const s = r.session, out = !!s.out_time, lat = out ? s.out_lat : s.in_lat, lng = out ? s.out_lng : s.in_lng;
  $app.innerHTML = `<div class="banner ok"><b>✓ ${title}</b> — saved to the attendance sheet.</div>${r.warning ? `<div class="banner warn">${esc(r.warning)}</div>` : ''}
    <div class="card"><div class="row"><span>Reference</span><b>${esc(s.ref)}</b></div><div class="row"><span>Site</span><span>${esc(s.site || '—')}</span></div>
    <div class="row"><span>Check-in</span><span>${fmtDate(s.date)} ${esc(s.in_time)}</span></div>
    ${out ? `<div class="row"><span>Check-out</span><span>${esc(s.out_time)}</span></div><div class="row"><span>Duration</span><b>${esc(s.duration)}</b></div>` : ''}
    <div class="row"><span>Location</span><a href="${mapLink(lat, lng)}" target="_blank" rel="noopener">${lat.toFixed(5)}, ${lng.toFixed(5)}</a></div>
    <div class="row"><span>GPS accuracy</span><span>about ${Math.round(Number(out ? s.out_acc : s.in_acc) || 0)} m</span></div>${img ? `<img class="thumb" src="${img}">` : ''}</div>
    <button id="ok">Done</button>`;
  document.getElementById('ok').onclick = loadHome;
}
async function showHistory() {
  try {
    const { sessions } = await call('history');
    $app.innerHTML = `<div class="card"><h3 style="margin:0 0 6px">History</h3>${sessions.map(s => `<div class="hist"><b>${fmtDate(s.date)}</b> &nbsp; IN ${esc(s.in_time)} → ${s.out_time ? 'OUT ' + esc(s.out_time) + ' (' + esc(s.duration) + ')' : '<span style="color:#b7791f">not logged out</span>'}<br><span class="small">${esc(s.site || '')} · ${esc(s.ref)}</span></div>`).join('') || '<div class="small">No records yet.</div>'}</div><button class="ghost" id="bk">Back</button>`;
    document.getElementById('bk').onclick = loadHome;
  } catch (e) { alert(e.message); }
}
store.get('pin') ? loadHome() : showLogin();
