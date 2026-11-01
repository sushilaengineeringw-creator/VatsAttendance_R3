/**
 * VATS Field Attendance - Google Apps Script backend.
 * Bound to a Google Sheet. Receives check-in / check-out from the Android app,
 * writes rows to the "Attendance" sheet and saves photos to Google Drive.
 * Every request is authenticated with Employee ID + PIN and re-checked against the Employees sheet.
 */
var TZ = 'Asia/Kolkata';
var COMPANY = 'VATS Filtration Technologies Pvt. Ltd.';
var LOW_ACCURACY_WARN_M = 100;  // only used to show a warning; attendance is never rejected for GPS accuracy
var MAX_PHOTO_B64 = 4000000;    // ~3 MB photo
var PHOTO_FOLDER = 'VATS Attendance Photos';
var MAX_FAILS = 5;              // wrong PIN attempts before a 15 minute lock

var EMP_H = ['Employee ID', 'Name', 'PIN', 'Status', 'Expiry Date', 'Designation', 'Site', 'Site Lat', 'Site Long', 'Radius (m)', 'Notes'];
var ATT_H = ['Ref', 'Date', 'Employee ID', 'Name', 'Site', 'IN Time', 'IN Lat', 'IN Long', 'IN Accuracy (m)', 'IN Map', 'Photo',
  'IN Distance from site (m)', 'IN On site?', 'OUT Time', 'OUT Lat', 'OUT Long', 'OUT Accuracy (m)', 'OUT Map', 'OUT On site?',
  'Duration', 'Status', 'IN Server Time', 'OUT Server Time', 'IN Key', 'OUT Key'];
var SEED_EMPLOYEES = [
 [
  "PR069",
  "ABHIJEET ACHINTA MUKHERJEE",
  ""
 ],
 [
  "PR004",
  "ABHISHEK SUBHASH YADAV",
  ""
 ],
 [
  "PR060",
  "ABHISHEKH MALIKARJUN CHAKALI",
  ""
 ],
 [
  "PR054",
  "AJAY PARASRAM VAIDYA",
  ""
 ],
 [
  "PR008",
  "AMOL JAGANNATH KADAM",
  ""
 ],
 [
  "VA025",
  "ANKIT RAMCHANDRA CHOUHAN",
  ""
 ],
 [
  "PR058",
  "ARIJIT JAYANTA MUKHERJEE",
  ""
 ],
 [
  "VA026",
  "DEEPAK SAROJ KUMAR",
  ""
 ],
 [
  "PR034",
  "DEVRAJ RUKHMACHANDRA MALAVIYA",
  ""
 ],
 [
  "VA022",
  "GIRRAJ KEVAL SINGH",
  ""
 ],
 [
  "VA045",
  "HARISHSINGH SHIVSINGH RAWAT",
  ""
 ],
 [
  "PR040",
  "INDRAJEET SUGHAR SINGH",
  ""
 ],
 [
  "PR023",
  "KUMAR SURESH MHATRE",
  ""
 ],
 [
  "VA027",
  "MANGESH SHAMRAO KANNAKE",
  ""
 ],
 [
  "VA018",
  "NAVEEN RAMESHCHANDRA KAREDIYA",
  ""
 ],
 [
  "VA044",
  "NAVEEN RAMSWAROOP RUDOLA",
  ""
 ],
 [
  "CO001",
  "P - PRAKASH",
  ""
 ],
 [
  "PR018",
  "PARVEEN PREMPAL KUMAR",
  ""
 ],
 [
  "PR062",
  "PUNDALIK NAMDEV PATIL",
  ""
 ],
 [
  "VA021",
  "RAMCHANDER MONDAIAH IRUGURALA",
  ""
 ],
 [
  "VA019",
  "RUSHIKESH RAJENDRA VIBHUTE",
  ""
 ],
 [
  "VA032",
  "SACHIN SANTOSH NINHAVE",
  ""
 ],
 [
  "VA043",
  "SATYA RAMADAS PRAKASH",
  ""
 ],
 [
  "PR034-B",
  "TUSHAR SANTOSH MESTRY",
  "Duplicate ID in the source report - correct this ID"
 ],
 [
  "PR052",
  "VIJAY SUDHAKAR CHAUDHARI",
  ""
 ],
 [
  "VA029",
  "VIKASH CHHAVINDER PALSRA",
  ""
 ],
 [
  "PR053",
  "VIKASH MAHESH PRAJAPATI",
  ""
 ],
 [
  "VA031",
  "VIVEK RAMESH CHAND",
  ""
 ]
];

function c_(n) { return ATT_H.indexOf(n); }
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sh_(n) { var s = ss_().getSheetByName(n); if (!s) throw fail_('SETUP', 'Server is not set up yet. Run setup() in Apps Script.'); return s; }
function fail_(code, msg, extra) { var e = new Error(msg); e.code = code; e.extra = extra || null; return e; }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function hm_(d) { return Utilities.formatDate(d, TZ, 'HH:mm'); }
function mapLink_(lat, lng) { return 'https://www.google.com/maps?q=' + lat + ',' + lng; }
function dayNum_(s) { var p = String(s).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; }

// ---------------- web app entry points ----------------
function doGet() { return ContentService.createTextOutput('VATS Attendance backend is running.'); }

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    out = route_(req); out.ok = true;
  } catch (err) {
    out = { ok: false, error: err.code || 'SERVER_ERROR', message: err.code ? err.message : 'Something went wrong. Please retry.' };
    if (err.extra) out.licence = err.extra;
    if (!err.code) console.error(err && err.stack || err);
  }
  out.server_time = new Date().toISOString();
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  switch (req.action) {
    case 'login': case 'me': return me_(req);
    case 'checkin': return checkin_(req);
    case 'checkout': return checkout_(req);
    case 'history': return history_(req);
    default: throw fail_('BAD_REQUEST', 'Unknown request.');
  }
}

// ---------------- employees, licence, auth ----------------
function readEmployees_() {
  var v = sh_('Employees').getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i]; if (!String(r[0]).trim()) continue;
    out.push({ row: i + 1, id: String(r[0]).trim(), name: String(r[1]).replace(/\s+/g, ' ').trim(), pin: String(r[2]).trim(), status: String(r[3]).trim(),
      expiry: r[4], designation: String(r[5] || ''), site: String(r[6] || ''), lat: parseFloat(r[7]), lng: parseFloat(r[8]), radius: parseFloat(r[9]) || 200 });
  }
  return out;
}

function licence_(emp, now) {
  var st = emp.status.toLowerCase(), exp = null;
  if (isDate_(emp.expiry)) exp = ymd_(emp.expiry);
  else if (String(emp.expiry || '').trim()) { var d = new Date(String(emp.expiry).trim()); if (!isNaN(d.getTime())) exp = ymd_(d); }
  var today = ymd_(now), left = exp ? dayNum_(exp) - dayNum_(today) : null;
  var base = { state: st || 'not_assigned', expiry: exp, days_left: left, valid: false };
  if (!st) { base.message = 'No licence assigned. Contact your administrator.'; return base; }
  if (st === 'suspended') { base.message = 'Your licence is suspended.'; return base; }
  if (st === 'revoked') { base.message = 'Your licence has been revoked.'; return base; }
  if (st !== 'active' && st !== 'trial') { base.state = 'not_assigned'; base.message = 'No valid licence. Contact your administrator.'; return base; }
  if (exp && exp < today) { base.state = 'expired'; base.message = 'Your licence has expired.'; return base; }
  base.valid = true;
  base.message = (st === 'trial' ? 'Trial' : 'Active') + ' licence' + (exp ? ' - ' + left + ' day' + (left === 1 ? '' : 's') + ' remaining. Expires on ' + exp + '.' : ' - no expiry date.');
  return base;
}

// Every request re-reads the sheet, so changing Status to Suspended blocks the very next request.
function auth_(req) {
  var id = String(req.id || '').trim().toUpperCase(), pin = String(req.pin || '').trim();
  if (!id || !pin) throw fail_('AUTH_BAD', 'Enter your Employee ID and PIN.');
  var cache = CacheService.getScriptCache(), fk = 'fail_' + id, fails = parseInt(cache.get(fk) || '0', 10);
  if (fails >= MAX_FAILS) throw fail_('AUTH_LOCKED', 'Too many wrong attempts. Try again after 15 minutes.');
  var list = readEmployees_(), emp = null;
  for (var i = 0; i < list.length; i++) if (list[i].id.toUpperCase() === id) { emp = list[i]; break; }
  if (!emp || emp.pin !== pin) { cache.put(fk, String(fails + 1), 900); throw fail_('AUTH_BAD', 'Incorrect Employee ID or PIN.'); }
  cache.remove(fk);
  emp.licence = licence_(emp, new Date());
  if (!emp.licence.valid) throw fail_('LICENCE_' + emp.licence.state.toUpperCase(), emp.licence.message, emp.licence);
  return emp;
}

// ---------------- attendance helpers ----------------
function attValues_() { return sh_('Attendance').getDataRange().getValues(); }
// Fast reader for daily actions: reads only the newest rows (header + last N). Rows keep their real row numbers
// (older rows are left empty) so findOpen_ / putRow_ work unchanged. Reports still use attValues_ (everything).
var RECENT_ROWS = 600;
function attRecent_(sheet) {
  sheet = sheet || sh_('Attendance');
  var last = sheet.getLastRow(), w = ATT_H.length;
  if (last <= RECENT_ROWS + 1) return sheet.getRange(1, 1, Math.max(last, 1), w).getValues();
  var out = [sheet.getRange(1, 1, 1, w).getValues()[0]], gap = [], start = last - RECENT_ROWS + 1;
  for (var i = 2; i < start; i++) out.push(gap);
  return out.concat(sheet.getRange(start, 1, RECENT_ROWS, w).getValues());
}
// Photo folder id is remembered so we do not search Drive by name on every check-in.
function photoFolder_() {
  var cache = CacheService.getScriptCache(), id = cache.get('photo_folder_id');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER), f = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
  try { cache.put('photo_folder_id', f.getId(), 21600); } catch (e) {}
  return f;
}
function findOpen_(v, id) {
  for (var i = v.length - 1; i >= 1; i--) if (String(v[i][c_('Employee ID')]) === id && v[i][c_('Status')] === 'OPEN') return { rowNum: i + 1, row: v[i] };
  return null;
}
function view_(r) {
  return { ref: r[c_('Ref')], date: r[c_('Date')], site: r[c_('Site')], in_time: r[c_('IN Time')], out_time: r[c_('OUT Time')] || null,
    in_ts: r[c_('IN Server Time')], out_ts: r[c_('OUT Server Time')] || null, in_lat: parseFloat(r[c_('IN Lat')]), in_lng: parseFloat(r[c_('IN Long')]),
    out_lat: r[c_('OUT Lat')] === '' ? null : parseFloat(r[c_('OUT Lat')]), out_lng: r[c_('OUT Long')] === '' ? null : parseFloat(r[c_('OUT Long')]),
    duration: r[c_('Duration')] || null, status: r[c_('Status')], in_on_site: r[c_('IN On site?')], in_acc: r[c_('IN Accuracy (m)')], out_acc: r[c_('OUT Accuracy (m)')] };
}
function distanceM_(a, b, c, d) {
  var R = 6371000, rad = function (x) { return x * Math.PI / 180; }, dl = rad(c - a), dn = rad(d - b);
  var h = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dn / 2) * Math.sin(dn / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
function checkLoc_(req) {
  var lat = Number(req.lat), lng = Number(req.lng), acc = Number(req.accuracy);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0))
    throw fail_('BAD_LOCATION', 'Location was not received. Turn ON Location (GPS) on your phone and try again.');
  return { lat: lat, lng: lng, acc: isFinite(acc) ? acc : 0 };   // any accuracy is accepted and recorded
}
function accWarn_(loc) { return loc.acc > LOW_ACCURACY_WARN_M ? 'GPS accuracy was low (about ' + Math.round(loc.acc) + ' m). The location was recorded as is.' : null; }
function siteCheck_(emp, loc) {
  if (!isFinite(emp.lat) || !isFinite(emp.lng)) return { dist: '', on: 'n/a' };
  var d = Math.round(distanceM_(loc.lat, loc.lng, emp.lat, emp.lng));
  return { dist: d, on: d <= emp.radius ? 'Yes' : 'No' };
}
function duration_(fromIso, to) {
  var m = Math.max(0, Math.floor((to.getTime() - new Date(fromIso).getTime()) / 60000));
  return ('0' + Math.floor(m / 60)).slice(-2) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm';
}
function putRow_(sheet, rowNum, arr) { var rg = sheet.getRange(rowNum, 1, 1, ATT_H.length); rg.setNumberFormat('@'); rg.setValues([arr]); }

// ---------------- actions ----------------
function me_(req) {
  var emp = auth_(req), v = attRecent_(), open = findOpen_(v, emp.id), today = ymd_(new Date()), last = null;
  for (var i = v.length - 1; i >= 1; i--) if (String(v[i][c_('Employee ID')]) === emp.id) { if (v[i][c_('Date')] === today) last = v[i]; break; }
  return { employee: { id: emp.id, name: emp.name, designation: emp.designation, site: emp.site }, licence: emp.licence,
    open_session: open ? view_(open.row) : null, last_session: last ? view_(last) : null };
}

function checkin_(req) {
  var emp = auth_(req);
  var idem = String(req.idem || '').slice(0, 80); if (!idem) throw fail_('BAD_REQUEST', 'Missing request key.');
  var loc = checkLoc_(req), b64 = String(req.photo || '').replace(/^data:[^,]*,/, '');
  if (!b64) throw fail_('PHOTO_REQUIRED', 'A fresh photo is required.');
  if (b64.length > MAX_PHOTO_B64) throw fail_('PHOTO_TOO_LARGE', 'Photo is too large. Please retake.');
  var sheet = sh_('Attendance');
  // Quick pre-check (no lock): a retry or a second check-in is answered at once, without uploading the photo again.
  var pre = attRecent_(sheet);
  for (var p = 1; p < pre.length; p++) if (pre[p][c_('IN Key')] === idem && String(pre[p][c_('Employee ID')]) === emp.id) return { duplicate: true, session: view_(pre[p]) };
  if (findOpen_(pre, emp.id)) throw fail_('ALREADY_CHECKED_IN', 'You already have an open attendance session. Please log out first.');
  // Slow part (Drive upload) runs OUTSIDE the lock so many technicians can check in at the same moment.
  var now = new Date(), site = siteCheck_(emp, loc), ref = 'ATT-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', ymd_(now) + '_' + emp.id + '_' + hm_(now).replace(':', '') + '_' + ref + '.jpg');
  var file = photoFolder_().createFile(blob), photoUrl = file.getUrl();
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var v = attRecent_(sheet);
    for (var i = 1; i < v.length; i++) if (v[i][c_('IN Key')] === idem && String(v[i][c_('Employee ID')]) === emp.id) { try { file.setTrashed(true); } catch (e) {} return { duplicate: true, session: view_(v[i]) }; }
    if (findOpen_(v, emp.id)) { try { file.setTrashed(true); } catch (e) {} throw fail_('ALREADY_CHECKED_IN', 'You already have an open attendance session. Please log out first.'); }
    var row = []; for (var k = 0; k < ATT_H.length; k++) row.push('');
    var set = function (n, val) { row[c_(n)] = val; };
    set('Ref', ref); set('Date', ymd_(now)); set('Employee ID', emp.id); set('Name', emp.name); set('Site', emp.site);
    set('IN Time', hm_(now)); set('IN Lat', loc.lat); set('IN Long', loc.lng); set('IN Accuracy (m)', Math.round(loc.acc)); set('IN Map', mapLink_(loc.lat, loc.lng));
    set('Photo', photoUrl); set('IN Distance from site (m)', site.dist); set('IN On site?', site.on); set('Status', 'OPEN');
    set('IN Server Time', now.toISOString()); set('IN Key', idem);
    putRow_(sheet, sheet.getLastRow() + 1, row);
    return { session: view_(row), warning: site.on === 'No' ? 'You are ' + site.dist + ' m from your assigned site. This was flagged for review.' : accWarn_(loc) };
  } finally { lock.releaseLock(); }
}

function checkout_(req) {
  var emp = auth_(req), lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var idem = String(req.idem || '').slice(0, 80), sheet = sh_('Attendance'), v = attRecent_(sheet);
    if (idem) for (var i = 1; i < v.length; i++) if (v[i][c_('OUT Key')] === idem && String(v[i][c_('Employee ID')]) === emp.id) return { duplicate: true, session: view_(v[i]) };
    var open = findOpen_(v, emp.id);
    if (!open) throw fail_('NO_OPEN_SESSION', 'You have no open attendance session to log out of.');
    var loc = checkLoc_(req), now = new Date(), site = siteCheck_(emp, loc), r = open.row.slice();
    var set = function (n, val) { r[c_(n)] = val; };
    set('OUT Time', hm_(now)); set('OUT Lat', loc.lat); set('OUT Long', loc.lng); set('OUT Accuracy (m)', Math.round(loc.acc)); set('OUT Map', mapLink_(loc.lat, loc.lng));
    set('OUT On site?', site.on); set('Duration', duration_(r[c_('IN Server Time')], now)); set('Status', 'CLOSED'); set('OUT Server Time', now.toISOString()); set('OUT Key', idem);
    putRow_(sheet, open.rowNum, r);
    return { session: view_(r), warning: accWarn_(loc) };
  } finally { lock.releaseLock(); }
}

function history_(req) {
  var emp = auth_(req), v = attRecent_(), out = [];
  for (var i = v.length - 1; i >= 1 && out.length < 60; i--) if (String(v[i][c_('Employee ID')]) === emp.id) out.push(view_(v[i]));
  return { sessions: out };
}

// ---------------- one-time setup ----------------
function setup() {
  var ss = ss_(); ss.setSpreadsheetTimeZone(TZ);
  var emp = ss.getSheetByName('Employees') || ss.insertSheet('Employees');
  if (emp.getLastRow() < 2) {
    emp.getRange(1, 1, 1, EMP_H.length).setValues([EMP_H]).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
    var rows = [], exp = new Date(Date.now() + 365 * 86400000);
    for (var i = 0; i < SEED_EMPLOYEES.length; i++) {
      var s = SEED_EMPLOYEES[i];
      rows.push([s[0], s[1], String(Math.floor(100000 + Math.random() * 900000)), 'Active', ymd_(exp), '', '', '', '', 200, s[2]]);
    }
    emp.getRange(2, 1, rows.length, 3).setNumberFormat('@');
    emp.getRange(2, 1, rows.length, EMP_H.length).setValues(rows);
    emp.setFrozenRows(1);
    try { emp.getRange(2, 4, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Active', 'Trial', 'Suspended', 'Revoked'], true).build()); } catch (e) {}
  }
  var att = ss.getSheetByName('Attendance') || ss.insertSheet('Attendance');
  if (att.getLastRow() < 1) {
    att.getRange(1, 1, 1, ATT_H.length).setNumberFormat('@').setValues([ATT_H]).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
    att.setFrozenRows(1);
  }
  var def = ss.getSheetByName('Sheet1'); if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  return 'Setup complete. PINs are in the Employees sheet.';
}

// ---------------- monthly reports (generated inside the spreadsheet) ----------------
function colL_(n) { var s = ''; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
var MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var WD_ = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var NAVY = '#1f3864', YELLOW = '#ffff00', GREEN = '#c6efce', RED = '#ffc7ce', ORANGE = '#ffd966';

function loadMonth_(year, month) {
  var prefix = year + '-' + ('0' + month).slice(-2) + '-', v = attValues_(), byDay = {}, all = [];
  for (var i = 1; i < v.length; i++) {
    var d = String(v[i][c_('Date')]); if (d.indexOf(prefix) !== 0) continue;
    var key = String(v[i][c_('Employee ID')]) + '|' + parseInt(d.slice(8, 10), 10);
    (byDay[key] = byDay[key] || []).push(v[i]); all.push(v[i]);
  }
  return { byDay: byDay, all: all };
}
function sessionHours_(r) {
  var a = r[c_('IN Server Time')], b = r[c_('OUT Server Time')];
  if (r[c_('Status')] !== 'CLOSED' || !a || !b) return 0;
  var h = (new Date(b).getTime() - new Date(a).getTime()) / 3600000; return h > 0 ? h : 0;
}
function sumHours_(list) { var t = 0; for (var i = 0; i < list.length; i++) t += sessionHours_(list[i]); return t; }
function round2_(x) { return Math.round(x * 100) / 100; }

// kind: 'pa' (P/A + total hours) or 'hours' (hours worked per day)
function makeGrid_(kind, year, month, emps, byDay) {
  var ss = ss_(), days = new Date(Date.UTC(year, month, 0)).getUTCDate(), ym = year + '-' + ('0' + month).slice(-2), today = ymd_(new Date());
  var name = (kind === 'pa' ? 'PA_' : 'Hours_') + ym, old = ss.getSheetByName(name); if (old) ss.deleteSheet(old);
  var sh = ss.insertSheet(name);
  var tot = kind === 'pa' ? ['Present (P)', 'Leave (L)', 'Weekly Off (WO)', 'Missed Logout (MC)', 'Total Hours Worked'] : ['Total Hours Worked', 'Days Worked'];
  var ncol = 3 + days + tot.length, nrow = 6 + emps.length, grid = [], bg = [];
  var blank = function (f) { var a = []; for (var i = 0; i < ncol; i++) a.push(f); return a; };
  for (var r = 0; r < nrow; r++) { grid.push(blank('')); bg.push(blank('#ffffff')); }
  grid[0][0] = COMPANY;
  grid[1][0] = (kind === 'pa' ? 'Monthly Attendance Register (P / A) with Hours' : 'Hours Worked per Day') + ' - ' + MONTHS_[month - 1] + ' ' + year;
  grid[2][0] = 'Generated: ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy hh:mm a') + ' IST';
  var hdr = ['Sr No.', 'Employee ID', 'Employee Name']; for (var d = 1; d <= days; d++) hdr.push(d); grid[4] = hdr.concat(tot);
  for (var c = 0; c < ncol; c++) bg[4][c] = NAVY;
  var wk = ['', '', '']; for (d = 1; d <= days; d++) { var dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay(); wk.push(WD_[dow]); if (dow === 0) { bg[4][2 + d] = YELLOW; bg[5][2 + d] = YELLOW; } }
  grid[5] = wk.concat(blank('').slice(0, tot.length));
  emps.forEach(function (e, idx) {
    var R = 6 + idx, row = grid[R], monthHours = 0; row[0] = idx + 1; row[1] = e.id; row[2] = e.name;
    for (var d = 1; d <= days; d++) {
      var date = year + '-' + ('0' + month).slice(-2) + '-' + ('0' + d).slice(-2), sun = new Date(Date.UTC(year, month - 1, d)).getUTCDay() === 0;
      var lst = byDay[e.id + '|' + d] || [], closed = lst.filter(function (x) { return x[c_('Status')] === 'CLOSED'; }), val = '', fill = '#ffffff';
      if (lst.length) {
        var hrs = sumHours_(lst); monthHours += hrs;
        val = kind === 'pa' ? (closed.length ? 'P' : 'MC') : (closed.length ? round2_(hrs) : 'MC');
        fill = closed.length ? GREEN : ORANGE;
      } else if (date <= today && kind === 'pa') { val = sun ? 'WO' : 'L'; fill = sun ? '#ffffff' : RED; }
      if (sun) fill = YELLOW;
      row[2 + d] = val; bg[R][2 + d] = fill;
    }
    var rg = colL_(4) + (R + 1) + ':' + colL_(3 + days) + (R + 1), t0 = 3 + days;
    if (kind === 'pa') {
      ['P', 'L', 'WO', 'MC'].forEach(function (code, k) { row[t0 + k] = '=COUNTIF(' + rg + ',"' + code + '")'; });
      row[t0 + 4] = round2_(monthHours);
    } else { row[t0] = '=ROUND(SUM(' + rg + '),2)'; row[t0 + 1] = '=COUNT(' + rg + ')'; }
  });
  sh.getRange(1, 1, nrow, ncol).setValues(grid);
  sh.getRange(1, 1, nrow, ncol).setBackgrounds(bg);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14); sh.getRange(2, 1).setFontWeight('bold');
  sh.getRange(5, 1, 1, ncol).setFontColor('#ffffff').setFontWeight('bold'); sh.getRange(5, 4, 1, days).setFontColor('#000000');
  sh.getRange(5, 1, nrow - 4, ncol).setHorizontalAlignment('center').setBorder(true, true, true, true, true, true);
  sh.getRange(7, 3, emps.length, 1).setHorizontalAlignment('left');
  sh.setFrozenRows(6); sh.setFrozenColumns(3); sh.setColumnWidth(3, 260);
  for (var cc = 4; cc <= 3 + days; cc++) sh.setColumnWidth(cc, kind === 'pa' ? 34 : 46);
  for (cc = 4 + days; cc <= ncol; cc++) sh.setColumnWidth(cc, 150);
  var L = nrow + 2, legend = kind === 'pa'
    ? [['P = login and logout both marked', GREEN], ['L = Leave (no attendance marked that day)', RED], ['WO = Sunday weekly off (yellow column)', YELLOW], ['MC = logged in, logout missing (hours not counted)', ORANGE]]
    : [['Number = hours worked that day (login to logout)', GREEN], ['MC = logged in, logout missing', ORANGE], ['Yellow column = Sunday', YELLOW]];
  sh.getRange(L, 1).setValue('Legend:').setFontWeight('bold');
  legend.forEach(function (l, i) { sh.getRange(L + 1 + i, 1).setValue(l[0]).setBackground(l[1]); });
  sh.getRange(L + legend.length + 1, 1).setValue('Dates after today are left blank (not counted absent). Public holidays are not configured. A night shift is counted on the day of login.');
  return sh;
}

// Location register: one row per session, with map links and the photo link (the geo-tag evidence).
function makeLocation_(year, month, all) {
  var ss = ss_(), ym = year + '-' + ('0' + month).slice(-2), name = 'Location_' + ym, old = ss.getSheetByName(name); if (old) ss.deleteSheet(old);
  var sh = ss.insertSheet(name);
  var H = ['Date', 'Employee ID', 'Name', 'Site', 'IN Time', 'IN Latitude', 'IN Longitude', 'IN Accuracy (m)', 'IN Location', 'Photo (geo-tag proof)', 'OUT Time', 'OUT Latitude', 'OUT Longitude', 'OUT Accuracy (m)', 'OUT Location', 'Hours Worked', 'Status', 'On site? (if site set)'];
  var rows = all.slice().sort(function (a, b) { return (String(a[c_('Date')]) + a[c_('IN Time')] + a[c_('Employee ID')]).localeCompare(String(b[c_('Date')]) + b[c_('IN Time')] + b[c_('Employee ID')]); });
  var grid = [[COMPANY], ['Location Register (login photo + GPS, logout GPS) - ' + MONTHS_[month - 1] + ' ' + year], ['Generated: ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy hh:mm a') + ' IST'], [''], H];
  rows.forEach(function (r) {
    var out = r[c_('Status')] === 'CLOSED', photo = r[c_('Photo')];
    grid.push([r[c_('Date')], r[c_('Employee ID')], r[c_('Name')], r[c_('Site')], r[c_('IN Time')], r[c_('IN Lat')], r[c_('IN Long')], r[c_('IN Accuracy (m)')],
      '=HYPERLINK("' + r[c_('IN Map')] + '","Open map")', photo ? '=HYPERLINK("' + photo + '","View photo")' : '',
      out ? r[c_('OUT Time')] : 'NOT LOGGED OUT', out ? r[c_('OUT Lat')] : '', out ? r[c_('OUT Long')] : '', out ? r[c_('OUT Accuracy (m)')] : '',
      out && r[c_('OUT Map')] ? '=HYPERLINK("' + r[c_('OUT Map')] + '","Open map")' : '', out ? round2_(sessionHours_(r)) : '', r[c_('Status')], r[c_('IN On site?')]]);
  });
  var ncol = H.length, nrow = grid.length;
  grid = grid.map(function (g) { while (g.length < ncol) g.push(''); return g; });
  sh.getRange(1, 1, nrow, ncol).setValues(grid);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14); sh.getRange(2, 1).setFontWeight('bold');
  sh.getRange(5, 1, 1, ncol).setBackground(NAVY).setFontColor('#ffffff').setFontWeight('bold');
  sh.setFrozenRows(5);
  var w = [90, 90, 230, 130, 70, 90, 90, 90, 90, 130, 110, 90, 90, 90, 90, 90, 80, 110];
  for (var i = 0; i < w.length; i++) sh.setColumnWidth(i + 1, w[i]);
  return sh;
}

function buildMonthly_(year, month) {
  var emps = readEmployees_(), m = loadMonth_(year, month);
  return [makeGrid_('pa', year, month, emps, m.byDay), makeGrid_('hours', year, month, emps, m.byDay), makeLocation_(year, month, m.all)];
}

// ---------------- menu ----------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Attendance')
    .addItem('Generate monthly reports...', 'menuMonthly').addItem('Excel download link for this tab', 'menuExcel').addToUi();
}
function menuMonthly() {
  var ui = SpreadsheetApp.getUi(), def = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  var r = ui.prompt('Generate monthly reports', 'Month (YYYY-MM):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var t = String(r.getResponseText() || def).trim(), m = /^(\d{4})-(\d{2})$/.exec(t);
  if (!m || +m[2] < 1 || +m[2] > 12) { ui.alert('Please type the month like 2026-10'); return; }
  buildMonthly_(+m[1], +m[2]); ui.alert('Created tabs PA_' + t + ', Hours_' + t + ' and Location_' + t + '.');
}
function menuExcel() {
  var ss = ss_(), s = ss.getActiveSheet(), url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx&gid=' + s.getSheetId();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput('<p>Excel file for tab <b>' + s.getName() + '</b>:</p><p><a href="' + url + '" target="_blank">Download .xlsx</a></p>'), 'Excel download');
}
