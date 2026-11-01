'use strict';
// Runs apps-script/Code.gs against an in-memory mock of SpreadsheetApp / DriveApp / etc.
// This tests OUR logic. It cannot prove Google's real services behave identically - see README.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

const { load } = require('./mock-google');
const post = (x, body) => JSON.parse(x.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
const GOOD = { lat: 18.5204, lng: 73.8567, accuracy: 12, loc_age_s: 3 };
const PHOTO = Buffer.from('fakejpegbytes').toString('base64');
const empRow = (E, id) => E.ss.getSheetByName('Employees').getDataRange().getValues().find(r => r[0] === id);
function setStatus(E, id, status, expiry) {
  const sh = E.ss.getSheetByName('Employees'), v = sh.getDataRange().getValues();
  const i = v.findIndex(r => r[0] === id); if (status !== undefined) sh.g[i][3] = status; if (expiry !== undefined) sh.g[i][4] = expiry;
}
function fresh() { const E = load(); E.x.setup(); const id = 'PR069', pin = empRow(E, id)[2]; return { E, id, pin, auth: { id, pin } }; }

test('setup seeds 28 employees with PINs; duplicate source ID is flagged, not merged', () => {
  const { E } = fresh(); const emps = E.x.readEmployees_();
  assert.equal(emps.length, 28); assert.equal(new Set(emps.map(e => e.id)).size, 28);
  assert.ok(emps.every(e => /^\d{6}$/.test(e.pin)));
  assert.ok(emps.some(e => e.id === 'PR034-B'));
});
test('wrong PIN rejected; lockout after 5 failures', () => {
  const { E, id } = fresh();
  assert.equal(post(E.x, { action: 'login', id, pin: '000000' }).error, 'AUTH_BAD');
  for (let i = 0; i < 5; i++) post(E.x, { action: 'login', id, pin: '000000' });
  assert.equal(post(E.x, { action: 'login', id, pin: empRow(E, id)[2] }).error, 'AUTH_LOCKED');
});
test('licence states are enforced on every request (suspended / revoked / expired / blank)', () => {
  const { E, id, auth } = fresh();
  assert.equal(post(E.x, { action: 'login', ...auth }).ok, true);
  setStatus(E, id, 'Suspended'); assert.equal(post(E.x, { action: 'me', ...auth }).error, 'LICENCE_SUSPENDED');
  setStatus(E, id, 'Revoked'); assert.equal(post(E.x, { action: 'me', ...auth }).error, 'LICENCE_REVOKED');
  setStatus(E, id, 'Active', '2020-01-01'); assert.equal(post(E.x, { action: 'me', ...auth }).error, 'LICENCE_EXPIRED');
  setStatus(E, id, '', ''); assert.equal(post(E.x, { action: 'me', ...auth }).error, 'LICENCE_NOT_ASSIGNED');
  setStatus(E, id, 'Trial', '2999-01-01'); const r = post(E.x, { action: 'me', ...auth }); assert.equal(r.ok, true); assert.equal(r.licence.state, 'trial');
});
test('suspension blocks check-in immediately', () => {
  const { E, id, auth } = fresh(); setStatus(E, id, 'Suspended');
  assert.equal(post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 'a', photo: PHOTO }).error, 'LICENCE_SUSPENDED');
  assert.equal(E.ss.getSheetByName('Attendance').getLastRow(), 1);
});
test('check-in, retry, duplicate, check-out, duplicate check-out', () => {
  const { E, auth } = fresh();
  assert.equal(post(E.x, { action: 'checkout', ...auth, ...GOOD, idem: 'o0' }).error, 'NO_OPEN_SESSION');
  const a = post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 'k1', photo: PHOTO }); assert.equal(a.ok, true);
  assert.equal(E.files.length, 1); assert.match(a.session.ref, /^ATT-/);
  const att = E.ss.getSheetByName('Attendance'); assert.equal(att.getLastRow(), 2);
  assert.match(att.g[1][E.x.ATT_H.indexOf('Photo')], /drive\.google\.com/); assert.match(att.g[1][E.x.ATT_H.indexOf('IN Map')], /maps\?q=18\.5204,73\.8567/);
  const retry = post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 'k1', photo: PHOTO }); assert.equal(retry.duplicate, true); assert.equal(att.getLastRow(), 2);
  assert.equal(post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 'k2', photo: PHOTO }).error, 'ALREADY_CHECKED_IN');
  const o = post(E.x, { action: 'checkout', ...auth, ...GOOD, idem: 'o1' }); assert.equal(o.ok, true); assert.equal(o.session.status, 'CLOSED'); assert.ok(o.session.out_time);
  assert.equal(att.getLastRow(), 2);                                                   // same row updated, not a new one
  assert.equal(post(E.x, { action: 'checkout', ...auth, ...GOOD, idem: 'o1' }).duplicate, true);
  assert.equal(post(E.x, { action: 'checkout', ...auth, ...GOOD, idem: 'o2' }).error, 'NO_OPEN_SESSION');
  assert.equal(post(E.x, { action: 'history', ...auth }).sessions.length, 1);
});
test('any GPS accuracy is accepted and recorded (with a warning); invalid location or missing photo is rejected', () => {
  const { E, auth } = fresh(); const H = E.x.ATT_H, att = E.ss.getSheetByName('Attendance');
  assert.equal(post(E.x, { action: 'checkin', ...auth, lat: 0, lng: 0, accuracy: 5, idem: 'g3', photo: PHOTO }).error, 'BAD_LOCATION');
  assert.equal(post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 'g4' }).error, 'PHOTO_REQUIRED');
  assert.equal(att.getLastRow(), 1);
  const r = post(E.x, { action: 'checkin', ...auth, ...GOOD, accuracy: 150, loc_age_s: 9999, idem: 'g5', photo: PHOTO });
  assert.equal(r.ok, true); assert.match(r.warning, /accuracy was low/); assert.equal(att.g[1][H.indexOf('IN Accuracy (m)')], 150);
  const o = post(E.x, { action: 'checkout', ...auth, ...GOOD, accuracy: 300, idem: 'g6' }); assert.equal(o.ok, true); assert.equal(att.g[1][H.indexOf('OUT Accuracy (m)')], 300);
  assert.equal(E.files.length, 1);
});
test('site distance flag: inside / outside / not configured', () => {
  const { E, id, auth } = fresh(); const sh = E.ss.getSheetByName('Employees'), i = sh.getDataRange().getValues().findIndex(r => r[0] === id);
  const H = E.x.ATT_H, att = E.ss.getSheetByName('Attendance');
  post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 's0', photo: PHOTO }); assert.equal(att.g[1][H.indexOf('IN On site?')], 'n/a');
  post(E.x, { action: 'checkout', ...auth, ...GOOD, idem: 'so0' });
  sh.g[i][7] = 18.5204; sh.g[i][8] = 73.8567; sh.g[i][9] = 200;
  post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 's1', photo: PHOTO }); assert.equal(att.g[2][H.indexOf('IN On site?')], 'Yes');
  post(E.x, { action: 'checkout', ...auth, ...GOOD, lat: 18.6, lng: 73.9, idem: 'so1' });
  const r = post(E.x, { action: 'checkin', ...auth, ...GOOD, lat: 18.6, lng: 73.9, idem: 's2', photo: PHOTO });
  assert.equal(att.g[3][H.indexOf('IN On site?')], 'No'); assert.match(r.warning, /flagged/);
});
test('monthly reports: P/A + total hours, Hours tab, flat Location tab with photo links, Sundays yellow, leap February', () => {
  const { E } = fresh(); const H = E.x.ATT_H, att = E.ss.getSheetByName('Attendance');
  const add = (id, date, tin, tout, status, inIso, outIso, photo) => {
    const r = H.map(() => ''); const set = (n, v) => { r[H.indexOf(n)] = v; };
    set('Ref', 'R' + att.g.length); set('Date', date); set('Employee ID', id); set('Name', 'X'); set('IN Time', tin); set('IN Lat', 18.5); set('IN Long', 73.8); set('IN Accuracy (m)', 60);
    set('IN Map', 'https://www.google.com/maps?q=18.5,73.8'); set('Photo', photo || ''); set('OUT Time', tout); set('Status', status); set('IN Server Time', inIso); set('OUT Server Time', outIso);
    if (status === 'CLOSED') { set('OUT Lat', 18.5); set('OUT Long', 73.8); set('OUT Accuracy (m)', 40); set('OUT Map', 'https://www.google.com/maps?q=18.5,73.8'); }
    att.g.push(r);
  };
  add('PR069', '2026-10-07', '09:00', '18:00', 'CLOSED', '2026-10-07T03:30:00Z', '2026-10-07T12:30:00Z', 'https://drive.google.com/file/d/1/view');   // 9 h
  add('PR069', '2026-10-08', '20:30', '06:30', 'CLOSED', '2026-10-08T15:00:00Z', '2026-10-09T01:00:00Z', 'https://drive.google.com/file/d/2/view');   // overnight 10 h, on login date
  add('PR069', '2026-10-09', '09:00', '12:00', 'CLOSED', '2026-10-09T03:30:00Z', '2026-10-09T06:30:00Z');                                        // 3 h
  add('PR069', '2026-10-09', '14:00', '18:00', 'CLOSED', '2026-10-09T08:30:00Z', '2026-10-09T12:30:00Z');                                        // 4 h
  add('PR069', '2026-10-11', '09:00', '17:00', 'CLOSED', '2026-10-11T03:30:00Z', '2026-10-11T11:30:00Z');                                        // Sunday, 8 h
  add('PR069', '2026-10-12', '09:00', '', 'OPEN', '2026-10-12T03:30:00Z', '');
  const [pa, hr, lo] = E.x.buildMonthly_(2026, 10);
  assert.deepEqual([pa.name, hr.name, lo.name], ['PA_2026-10', 'Hours_2026-10', 'Location_2026-10']);
  assert.equal(pa.g[4][3 + 30], 31); assert.equal(pa.g[4][3 + 31 + 4], 'Total Hours Worked');
  const row = pa.g.find(r => r[1] === 'PR069'), ri = pa.g.indexOf(row), cell = (d) => row[2 + d];
  assert.deepEqual([cell(7), cell(8), cell(9), cell(11), cell(12), cell(13)], ['P', 'P', 'P', 'P', 'MC', 'L']);
  assert.equal(cell(4), 'WO');
  for (const d of [4, 11, 18, 25]) { assert.equal(pa.bg[4][2 + d], '#ffff00'); assert.equal(pa.bg[ri][2 + d], '#ffff00'); }
  assert.equal(pa.bg[ri][2 + 7], '#c6efce');
  assert.equal(row[3 + 31 + 4], 34);                                                    // 9 + 10 + 3 + 4 + 8 ; the open session adds nothing
  const hrow = hr.g.find(r => r[1] === 'PR069');
  assert.deepEqual([hrow[2 + 7], hrow[2 + 8], hrow[2 + 9], hrow[2 + 11], hrow[2 + 12]], [9, 10, 7, 8, 'MC']);
  assert.match(hrow[3 + 31], /^=ROUND\(SUM\(D\d+:AH\d+\),2\)$/);
  const data = lo.g.slice(5).filter(r => r[1] === 'PR069');
  assert.equal(data.length, 6);
  assert.equal(data[0][0], '2026-10-07'); assert.match(data[0][8], /^=HYPERLINK\("https:\/\/www\.google\.com\/maps/); assert.match(data[0][9], /drive\.google\.com\/file\/d\/1/);
  assert.equal(data[0][15], 9); assert.equal(data[5][10], 'NOT LOGGED OUT'); assert.equal(data[5][14], '');
  const [feb] = E.x.buildMonthly_(2028, 2); assert.equal(feb.g[4][3 + 28], 29); assert.equal(feb.g[4][3 + 29], 'Total Hours Worked'.length ? 'Present (P)' : '');
  E.x.buildMonthly_(2026, 10); assert.equal(E.sheets.filter(s => s.name === 'PA_2026-10').length, 1);   // regenerating replaces tabs
});

test('speed: second check-in is refused BEFORE any photo upload; open session still found after 700 old rows', () => {
  const { E, auth } = fresh(); const att = E.ss.getSheetByName('Attendance');
  assert.equal(post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 's1', photo: PHOTO }).ok, true);
  const n = E.files.length;
  assert.equal(post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 's2', photo: PHOTO }).error, 'ALREADY_CHECKED_IN');
  assert.equal(E.files.length, n);                                          // no extra photo saved
  assert.equal(post(E.x, { action: 'checkin', ...auth, ...GOOD, idem: 's1', photo: PHOTO }).duplicate, true);
  assert.equal(E.files.length, n);                                          // retry also uploads nothing
  // pad 700 old closed rows of another person BEFORE our row is... simulate a big history by appending after
  const H = E.x.ATT_H, w = H.length;
  for (let i = 0; i < 700; i++) { const r = Array(w).fill(''); r[H.indexOf('Employee ID')] = 'OTHER'; r[H.indexOf('Status')] = 'CLOSED'; att.g.push(r); }
  const other = { id: Object.keys({}).length ? '' : E.x.readEmployees_()[1].id }; other.pin = E.x.readEmployees_()[1].pin;
  assert.equal(post(E.x, { action: 'checkin', ...other, ...GOOD, idem: 'b1', photo: PHOTO }).ok, true);   // new person works with a long sheet
  assert.equal(post(E.x, { action: 'history', ...other }).sessions.length, 1);
});
