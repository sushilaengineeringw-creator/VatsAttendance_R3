'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
function chain(target) {
  const p = new Proxy(target, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : () => p)) });
  return p;
}
class Sheet {
  constructor(name, id) { this.name = name; this.id = id; this.g = []; this.bg = []; }
  _ensure(r, c) { while (this.g.length < r) this.g.push([]); for (let i = 0; i < r; i++) while (this.g[i].length < c) this.g[i].push(''); }
  getLastRow() { let n = 0; this.g.forEach((r, i) => { if (r.some(v => v !== '' && v != null)) n = i + 1; }); return n; }
  getLastColumn() { let n = 0; this.g.forEach(r => r.forEach((v, j) => { if (v !== '' && v != null) n = Math.max(n, j + 1); })); return n; }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getSheetId() { return this.id; } getName() { return this.name; }
  getRange(r, c, nr = 1, nc = 1) {
    const s = this;
    const rg = {
      getValues: () => { s._ensure(r + nr - 1, c + nc - 1); return Array.from({ length: nr }, (_, i) => s.g[r - 1 + i].slice(c - 1, c - 1 + nc)); },
      setValues: (v) => { s._ensure(r + nr - 1, c + nc - 1); v.forEach((row, i) => row.forEach((x, j) => { s.g[r - 1 + i][c - 1 + j] = x; })); return chain(rg); },
      setValue: (x) => { s._ensure(r, c); s.g[r - 1][c - 1] = x; return chain(rg); },
      setBackgrounds: (b) => { b.forEach((row, i) => row.forEach((x, j) => { (s.bg[r - 1 + i] = s.bg[r - 1 + i] || [])[c - 1 + j] = x; })); return chain(rg); },
      setBackground: (x) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) (s.bg[r - 1 + i] = s.bg[r - 1 + i] || [])[c - 1 + j] = x; return chain(rg); },
    };
    return chain(rg);
  }
}
function makeEnv() {
  const sheets = [], cache = {}, files = [], folders = {}; let sid = 1;
  const ss = chain({
    getSheetByName: (n) => sheets.find(s => s.name === n) || null,
    insertSheet: (n) => { const s = chain(new Sheet(n, sid++)); sheets.push(s); return s; },
    deleteSheet: (s) => { sheets.splice(sheets.indexOf(s), 1); },
    getSheets: () => sheets, getId: () => 'SSID',
  });
  const env = {
    console, Math, Date, JSON, Number, String, parseInt, parseFloat, isFinite, isNaN, Object, Array, Error,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, newDataValidation: () => chain({}) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => chain({ getContent: () => s }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    Utilities: {
      formatDate: (d, tz, f) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
        return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('hh', p.hour).replace('mm', p.minute).replace(' a', '');
      },
      getUuid: () => crypto.randomUUID(), base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
    DriveApp: {
      getFoldersByName: (n) => ({ hasNext: () => !!folders[n], next: () => folders[n] }),
      getFolderById: (id) => { const f = Object.values(folders).find(x => x.id === id); if (!f) throw new Error('no folder'); return f; },
      createFolder: (n) => (folders[n] = { id: 'FOLDER1', getId() { return 'FOLDER1'; }, createFile: (b) => { files.push(b); const n = files.length; return { getUrl: () => 'https://drive.google.com/file/d/' + n + '/view', setTrashed: () => { b.trashed = true; } }; } }),
    },
  };
  return { env, sheets, files, ss };
}
function load() {
  const E = makeEnv(); const ctx = vm.createContext(E.env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8') + '\n;this.__x={doPost,setup,buildMonthly_,readEmployees_,ATT_H,SEED_EMPLOYEES};', ctx);
  return { ...E, x: ctx.__x };
}

module.exports = { load, makeEnv, chain };
