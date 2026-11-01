# Setup (about 15 minutes, one time)

## A. Google Sheet + script  (use the Google account that should own the data)
1. Go to sheets.google.com -> **Blank** spreadsheet -> name it `VATS Attendance`.
2. **Extensions -> Apps Script**. Delete the sample code. Open `apps-script/Code.gs` from this folder in Notepad, copy everything, paste it in, press **Save**.
3. In the function drop-down choose **setup** -> **Run**. Allow the permissions it asks for (Advanced -> Go to project -> Allow).
   This creates the `Employees` and `Attendance` tabs and fills your 28 employees with a PIN each.
4. **Deploy -> New deployment -> Select type: Web app**. Execute as: **Me**. Who has access: **Anyone**. Deploy and copy the **Web app URL** (ends with `/exec`).
5. Reload the Google Sheet. An **Attendance** menu appears at the top.

## B. Employees tab (your control panel)
* **PIN**: give each technician their Employee ID + PIN.
* **Status**: `Active`, `Trial`, `Suspended` or `Revoked`. Change it and the technician is blocked on their next action.
* **Expiry Date**: optional, `yyyy-mm-dd`.
* **Site, Site Lat, Site Long, Radius**: optional. If filled, each check-in shows the distance and `On site? Yes/No`.
* Row for `PR034-B` was a duplicate ID in your report - correct it.

## C. Build the APK on GitHub
1. Delete the old files in your GitHub repo (or create a new repo) and upload the **contents** of this zip (include the hidden `.github` folder).
2. Repo -> Settings -> Secrets and variables -> Actions -> **Variables** -> New variable: `SERVER_URL` = the Web app URL from step A4.
3. Actions -> Build Android APK -> Run workflow. Download the APK from **Artifacts**, install on phones.

## D. Daily use
* Attendance tab = every check-in/out with Google Maps links and photo links (photos are in your Drive folder `VATS Attendance Photos`, private to you).
* Monthly report: **Attendance -> Generate monthly reports...** -> type `2026-10`. Three tabs are created: `PA_2026-10` (Present P / Leave L + total hours, Sundays yellow), `Hours_2026-10` (hours worked per day) and `Location_2026-10` (one row per login/logout with map links and the photo link).
* Excel: open a tab -> **Attendance -> Excel download link for this tab**. Each tab downloads as its own Excel file, so the location file is separate from the P/A file.
* If you change `Code.gs` later: Deploy -> Manage deployments -> edit -> Version: New version -> Deploy (URL stays the same).

## E. Updating Code.gs later (IMPORTANT)
Pasting new code is not enough. After pasting: **Deploy -> Manage deployments -> pencil icon -> Version: New version -> Deploy**. The URL stays the same, so the app does not need rebuilding for backend-only changes.
