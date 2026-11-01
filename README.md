# VATS Field Attendance (Google Sheet edition)

Android app (Capacitor) -> Google Apps Script -> Google Sheet + Google Drive. No server to host or pay for.

* Start with **SETUP_GOOGLE_SHEET.md**.
* `apps-script/Code.gs` - the whole backend (paste into Apps Script).
* `www/` - the phone app. `.github/workflows/build-apk.yml` - builds the APK. `tests/` - `npm test` runs the backend logic against a mock of Google's services.

## Limits (be aware)
* The APK and the real Google deployment were **not run** in the environment that produced this zip. Tests use a mock of Google services, so real-world quirks (permissions prompts, quotas, redirects in the WebView) can still appear. Test with 2-3 phones before rollout.
* Security is PIN-based: anyone with the web app URL can try to sign in, but every request needs a valid Employee ID + PIN (5 wrong tries lock that ID for 15 minutes). Photos stay private in your Drive.
* GPS accuracy is **not** a condition for marking attendance: the app takes the best reading it can get in ~15 s and records the accuracy next to it (a warning shows above 100 m).
* Check-in time on the photo band is the phone's clock; the sheet also stores the Google server time.
* Front camera is requested; some phones may open the rear camera. GPS can be spoofed - the sheet shows distance from site for review.
* Google free-account quotas apply (fine for ~30 technicians, but check if you grow a lot).
* Not included: holidays/leave, offline queue, correction requests, admin web dashboard (the Google Sheet is the dashboard).
