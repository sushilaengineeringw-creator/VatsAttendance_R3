'use strict';
// Run AFTER `npx cap add android`. Adds permissions and installs the committed debug keystore
// so every CI build is signed with the same key (lets new APKs update an installed one).
const fs = require('fs'), path = require('path'), os = require('os');
const root = path.join(__dirname, '..');
const mf = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'];
const feats = ['<uses-feature android:name="android.hardware.camera" android:required="false" />', '<uses-feature android:name="android.hardware.location.gps" android:required="false" />'];
const add = [];
for (const p of perms) if (!x.includes(`"${p}"`)) add.push(`    <uses-permission android:name="${p}" />`);
for (const f of feats) if (!x.includes(f.match(/android:name="([^"]+)"/)[1])) add.push('    ' + f);
if (add.length) x = x.replace('</manifest>', add.join('\n') + '\n</manifest>');
if (!x.includes('usesCleartextTraffic')) x = x.replace('<application', '<application\n        android:usesCleartextTraffic="false"');
fs.writeFileSync(mf, x);
const ks = path.join(root, 'debug.keystore');
if (fs.existsSync(ks)) { const d = path.join(os.homedir(), '.android'); fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(ks, path.join(d, 'debug.keystore')); console.log('debug keystore installed'); }
console.log('AndroidManifest patched');
