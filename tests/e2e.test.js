'use strict';
// END-TO-END: the real www/app.js, running on the real Capacitor Android bridge (fake phone: camera + GPS),
// talking to the real apps-script/Code.gs (mock Google Sheet/Drive). Login -> photo -> GPS -> submit -> logout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load } = require('./mock-google');

const bridgeSrc = fs.readFileSync(path.join(__dirname, '../node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../www/app.js'), 'utf8');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, what, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return; await wait(10); } throw new Error('Timed out waiting for: ' + what); }

function startApp(google, { denyCamera = false } = {}) {
  const els = {}, store = {}, shown = { alerts: [] };
  const app = { _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = v; for (const k of Object.keys(els)) delete els[k]; for (const m of v.matchAll(/id="([^"]+)"/g)) els[m[1]] = { value: '', textContent: '', disabled: false, onclick: null, classList: { add() {}, remove() {} }, insertAdjacentHTML() {}, remove() {} }; }, insertAdjacentHTML() {} };
  const document = { getElementById: (id) => (id === 'app' ? app : id === 'who' || id === 'hdr' ? { textContent: '' } : els[id] || null), addEventListener() {}, querySelector: () => null, createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }), toDataURL: () => 'data:image/jpeg;base64,QUJD', style: {} }), hidden: false };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval: (f, m) => { const t = setInterval(f, m); t.unref && t.unref(); return t; }, clearInterval, Promise, JSON, Date, Math, Error, Object, Proxy, Array, String, Number, Map, Set, Symbol, Reflect, WeakMap, Uint8Array,
    parseInt, parseFloat, isFinite, navigator: {}, Document: function () {}, HTMLDocument: function () {}, Element: function () {}, HTMLElement: function () {}, Event: function () {}, CustomEvent: function () {}, XMLHttpRequest: function () {}, FormData: function () {}, Headers: function () {}, Request: function () {}, Response: function () {}, URL, Blob, TextEncoder, TextDecoder,
    document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    alert: (m) => shown.alerts.push(m), confirm: () => true, prompt: () => null, crypto: { randomUUID: () => 'uuid-' + Math.random() },
    Image: class { set src(v) { setTimeout(() => { this.width = 800; this.height = 600; this.onload && this.onload(); }, 0); } },
    fetch: async (url, opts) => { const out = JSON.parse(google.x.doPost({ postData: { contents: opts.body } }).getContent()); return { json: async () => out }; } });
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.addEventListener = () => {};
  ctx.APP_CONFIG = { SERVER_URL: 'https://script.google.com/macros/s/TEST/exec' };
  ctx.androidBridge = { postMessage: (m) => { const d = JSON.parse(m); setTimeout(() => {
    const reply = (r) => ctx.Capacitor.fromNative({ pluginId: d.pluginId, methodName: d.methodName, callbackId: d.callbackId, ...r });
    if (d.pluginId === 'Camera') {
      if (d.methodName === 'checkPermissions') reply({ success: true, data: { camera: denyCamera ? 'denied' : 'granted' } });
      else if (d.methodName === 'requestPermissions') reply({ success: true, data: { camera: denyCamera ? 'denied' : 'granted' } });
      else if (d.methodName === 'getPhoto') reply({ success: true, data: { base64String: 'QUJDREVG', format: 'jpeg' } });
    } else if (d.pluginId === 'Geolocation') {
      if (d.methodName === 'checkPermissions') reply({ success: true, data: { location: 'granted' } });
      else if (d.methodName === 'watchPosition') [90, 56, 15].forEach((a, i) => setTimeout(() => reply({ success: true, data: { timestamp: Date.now(), coords: { latitude: 18.5204, longitude: 73.8567, accuracy: a } }, save: true }), 15 * (i + 1)));
      else reply({ success: true, data: {} });
    } }, 3); } };
  ctx.Capacitor = { PluginHeaders: [{ name: 'Camera' }, { name: 'Geolocation' }] };
  vm.runInContext(bridgeSrc + '\n;', ctx);
  vm.runInContext(appSrc, ctx);
  return { app, els, store, shown, click: async (id) => { await until(() => els[id] && els[id].onclick, 'button ' + id); els[id].onclick({ target: els[id] }); } };
}
const sheetRows = (G) => G.ss.getSheetByName('Attendance').getDataRange().getValues();

test('app starts and shows the login page (not a blank screen)', async () => {
  const G = load(); G.x.setup(); const a = startApp(G);
  await until(() => a.app.innerHTML.includes('Sign in'), 'login page');
  assert.ok(a.app.innerHTML.includes('Employee ID')); assert.ok(a.app.innerHTML.includes('PIN'));
});
test('wrong PIN shows an error and stays on login', async () => {
  const G = load(); G.x.setup(); const a = startApp(G);
  await until(() => a.els.go && a.els.go.onclick, 'login button'); a.els.u.value = 'PR001'; a.els.p.value = '000000'; a.els.err = a.els.err || { classList: { add() {}, remove() {} } };
  await a.click('go'); await until(() => a.els.err && a.els.err.textContent, 'error text'); assert.match(a.els.err.textContent, /Incorrect/);
});
test('FULL FLOW: login -> photo + GPS -> submit -> row in sheet -> logout -> OUT location in sheet', async () => {
  const G = load(); G.x.setup();
  const emp = G.x.readEmployees_()[0]; assert.ok(emp);
  const a = startApp(G);
  await until(() => a.els.go && a.els.go.onclick, 'login button'); a.els.u.value = emp.id.toLowerCase(); a.els.p.value = emp.pin;
  await a.click('go');
  await until(() => a.app.innerHTML.includes('MARK ATTENDANCE'), 'home screen'); assert.ok(a.app.innerHTML.includes(emp.name));
  assert.ok(a.app.innerHTML.includes('App v2.5'));
  await a.click('in');                                                              // camera via the real bridge
  await until(() => a.app.innerHTML.includes('Confirm your photo'), 'photo preview');
  await a.click('sub');                                                             // location (best of 3) + stamp + upload
  await until(() => a.app.innerHTML.includes('Attendance recorded'), 'success screen', 6000);
  const H = G.x.ATT_H; let rows = sheetRows(G); assert.equal(rows.length, 2);
  assert.equal(rows[1][H.indexOf('Employee ID')], emp.id); assert.equal(rows[1][H.indexOf('Status')], 'OPEN');
  assert.equal(rows[1][H.indexOf('IN Accuracy (m)')], 15);                          // the best of the three readings
  assert.match(rows[1][H.indexOf('IN Map')], /maps\?q=18\.5204,73\.8567/); assert.match(rows[1][H.indexOf('Photo')], /drive\.google\.com/);
  assert.equal(G.files.length, 1);
  await a.click('ok');
  await until(() => a.app.innerHTML.includes('LOG OUT'), 'home with logout button');
  await a.click('out');
  await until(() => a.app.innerHTML.includes('Logged out'), 'logout screen', 6000);
  rows = sheetRows(G); assert.equal(rows.length, 2); assert.equal(rows[1][H.indexOf('Status')], 'CLOSED');
  assert.match(rows[1][H.indexOf('OUT Map')], /maps\?q=18\.5204,73\.8567/); assert.ok(rows[1][H.indexOf('Duration')]);
});
test('camera permission denied shows a clear message and records nothing', async () => {
  const G = load(); G.x.setup(); const emp = G.x.readEmployees_()[0]; const a = startApp(G, { denyCamera: true });
  await until(() => a.els.go && a.els.go.onclick, 'login'); a.els.u.value = emp.id; a.els.p.value = emp.pin; await a.click('go');
  await until(() => a.app.innerHTML.includes('MARK ATTENDANCE'), 'home'); await a.click('in');
  await until(() => a.shown.alerts.length, 'alert'); assert.match(a.shown.alerts[0], /Camera permission is denied/); assert.equal(sheetRows(G).length, 1);
});
test('suspended employee is signed out on the next action', async () => {
  const G = load(); G.x.setup(); const emp = G.x.readEmployees_()[0]; const a = startApp(G);
  await until(() => a.els.go && a.els.go.onclick, 'login'); a.els.u.value = emp.id; a.els.p.value = emp.pin; await a.click('go');
  await until(() => a.app.innerHTML.includes('MARK ATTENDANCE'), 'home');
  const sh = G.ss.getSheetByName('Employees'); sh.g[sh.getDataRange().getValues().findIndex(r => r[0] === emp.id)][3] = 'Suspended';
  await a.click('in'); await until(() => a.app.innerHTML.includes('Confirm your photo'), 'preview'); await a.click('sub');
  await until(() => a.app.innerHTML.includes('Sign in'), 'sign-in page after suspension', 6000); assert.match(a.app.innerHTML, /suspended/i); assert.equal(sheetRows(G).length, 1);
});
