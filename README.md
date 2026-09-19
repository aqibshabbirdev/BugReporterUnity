# Bug Reporter (Unity)

In-game bug reporting for game teams. A tester presses a button; you get a ticket with the
screenshot, the last log lines, the device, and the build it happened on — before anyone opens Jira.

**Live deployment:** https://pandabugsreporting.com (cPanel/Passenger on the GoDaddy WHM server — see §4)
**Legacy deployment:** https://bugreporterunity.wasmer.app (Wasmer app `bugreporterunity`, owner `aqibshabbirdev`; still up with the old data, no longer the target — see §4b)
**Repo:** https://github.com/aqibshabbirdev/BugReporterUnity

> This README is the working documentation for the whole system — architecture, deploy, ops,
> integration, and every hard-won gotcha. If you are picking this project up fresh, read it end to end.

---

## 1. Architecture

```
Unity game ──(multipart POST /api/report, X-Api-Key)──► Flask backend on Wasmer ──► managed MySQL
                                                            │                        (Wasmer add-on)
                                                            ├── screenshots/logs → /data volume
                                                            └── serves the React dashboard (backend/static)
Browser ──(session cookie)──► same Flask app → dashboard SPA + /api/* JSON
```

- **One deployable**: the Flask app serves both the JSON API and the built dashboard (SPA fallback).
- **No Firebase anywhere.** An early plan used Cloud Functions; it was dropped (paid) in favor of
  Wasmer's free tier. Ignore any stale references to `functions/`.

## 2. Repository layout

| Path | What |
|---|---|
| `main.py` | Wasmer entry point — inserts `backend/` on `sys.path`, exposes `app` for the python preset |
| `requirements.txt` | Root-level (Wasmer reads it here): `flask`, `pymysql` |
| `app.yaml` | **Critical** Wasmer app binding — see §4. Never delete it |
| `backend/app/__init__.py` | `create_app()`, `/api/health` diagnostics, SPA fallback, `DB_INIT_ERROR` surfacing |
| `backend/app/db.py` | PyMySQL layer: lazy import, WASIX `USER` shim, `?`→`%s` conn shim, schema bootstrap |
| `backend/app/ingest.py` | `POST /api/report` — API-key auth, rate limit, size caps, JPEG magic check, upsert |
| `backend/app/api.py` | Dashboard API: auth, projects, issues, comments, builds, key rotation, file serving |
| `backend/static/` | **Built** dashboard output (checked in — Wasmer serves it as-is, no node build on deploy) |
| `dashboard/` | React + Vite + TS source (5 pages: Login, Projects, Issues, IssueDetail, Settings) |
| `unity-sdk/Packages/com.bugreporter.sdk/` | UPM package — the in-game reporter |
| `PLAN.md` | Original scope/data-model/milestones doc |

## 3. Unity SDK

### Install
Package Manager → *Add package from git URL*:
```
https://github.com/aqibshabbirdev/BugReporterUnity.git?path=unity-sdk/Packages/com.bugreporter.sdk
```

### Initialize (once at boot)
```csharp
using BugReporterSdk;

[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
static void InitBugReporter()
{
    BugReporter.Init(new BugReporterConfig
    {
        ApiKey   = "br_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",   // per-project, from the dashboard
        Endpoint = "https://pandabugsreporting.com/api/report",
        Enabled  = true,          // gate on your own dev flag for release builds
        BuildVersion = Application.version,
        GameId   = "Hub",         // starting game; change it at runtime with SetGame (see below)
        // IncludeWarnings = false // default — warnings are dropped from the log buffer (see §3.1)
    });
}
```

### Many games, one key — automatic per game
One project = one API key, but a hub app ships **many games** under it. Without a game tag every report
lands in one mixed pile. This resolves itself with **zero per-game wiring**:

- The SDK stamps every report with the **active scene's asset path** (`SceneManager.GetActiveScene().path`,
  e.g. `Assets/_Games/CRICKET/Scene/Ground.unity` — the path survives into builds).
- The backend derives the game from the folder right after `_Games/` (`ingest._game_from_scene`) and maps it
  to a display name (`CRICKET → Cricket`, `8Ball pool → 8 Ball Pool`, …). It's a folder-segment match, **not**
  a plain substring — so `Car` doesn't get swallowed by `Carrom`. Unknown folders pass through as-is, so a
  **new game appears in the dashboard with no code change** (add a row in `_GAME_NAMES` only to prettify the label).

The dashboard then shows a **game filter** (like the build filter) so each game's issues are a separate list.
Scenes outside `_Games/` (Login, Loading, Connection) carry no game and show as `—`. A few scenes whose folder
would mislabel them are special-cased in `_SCENE_OVERRIDES` (checked first) — e.g. the app's global lobby
lives under the 8Ball pool folder but is tagged **Lobby**, not 8 Ball Pool.

**Optional manual override — `SetGame`:** if you ever need to label a report explicitly (a game not laid out
under `_Games/`, or a custom label), call `BugReporter.SetGame("Cricket")`. When set, the server prefers it
over the scene-derived value; it sticks until the next call. Most integrations won't need it.

### Multiplayer — link both devices to one incident
A networked bug has two sides: each device has its own logs, screenshot and state, so a tester files it
from **both** devices. To stop those becoming two unrelated issues, tag every report with the shared
match id — call `BugReporter.SetSession(...)` with the **same value on every device** when a match starts
(the server's transaction/match id works well), and clear it (`SetSession(null)`) when it ends:
```csharp
BugReporter.SetSession(match.transactionId);   // same id on device 1 and device 2
```
Reports that share a session are linked: the issue detail page shows a **"Same multiplayer session — N other
devices"** panel with the other device's report(s) (jump straight to their logs/screenshot), and the grid
stamps a **🔗 linked** badge on those cards. Derivation is automatic from `issues.session`; no session → no link.

### Clip recording — the last N seconds as a flipbook
A report can carry a short clip of what led to the bug. It's **off by default** (`RecordClip`) because it
captures the screen continuously — a small but real perf/battery cost, so keep it to tester builds:
```csharp
BugReporter.Init(new BugReporterConfig {
    /* … */
    RecordClip = ConstantsData_M.MpVerboseLogs,   // tester-only
    ClipSeconds = 12, ClipFps = 12, ClipMaxWidth = 480, ClipQuality = 55,   // defaults
});
```
How it works: `ClipRecorder` keeps a rolling ring of the last `ClipSeconds × ClipFps` frames — each a
downscaled JPEG captured via `ScreenCapture.CaptureScreenshotIntoRenderTexture` + **async GPU readback**
(so it doesn't stall the render thread; needs `SystemInfo.supportsAsyncGPUReadback`, else it no-ops). On a
report the frames are packed into one blob (`[u32 count][u32 len]×count][bytes…]`), uploaded as the `clip`
part, split back into `clip/000.jpg…` on ingest, and the dashboard plays them as a flipbook on the issue page
(play/pause, frame-by-frame ◀ ▶, speed, click to enlarge). Last ~12s at 12fps ≈ 3–6 MB.

`ClipFps` also travels with the report (JSON `clipFps` → a `clip/fps` marker file → `GET …/clip`), because a
player guessing a fixed rate runs the clip in slow motion or fast-forward. Clips from before that marker
existed fall back to 6fps. Tuning: **below ~10fps it's too choppy and under ~400px too blurry to read** —
that's what the defaults are set around. If the clip is upside-down on a device, set `ClipFlipY = true`.

### 3.1 Log noise — warnings are excluded by default
`Debug.LogWarning` lines are **not** captured in the report's log buffer — a single frame can emit dozens
and shove the real error out of the 200-line ring. Errors, asserts and exceptions are always kept. Flip
`IncludeWarnings = true` in the config if you actually need them.

Runtime pieces (`unity-sdk/Packages/com.bugreporter.sdk/Runtime/`):
- `BugReporter.cs` — entry; trims/validates the key (`br_` prefix enforced — a leading typo like
  `bbr_` silently 401s otherwise; this bit us once).
- `LogBuffer.cs` — thread-safe ring buffer of recent `Debug.Log*` lines (captured via
  `Application.logMessageReceivedThreaded`). Warnings are dropped unless `IncludeWarnings = true` (§3.1).
- `ReportOverlay.cs` — the on-screen "Report" button + note field (OnGUI, no scene objects needed).
- `ReportSender.cs` — end-of-frame screenshot capture, multipart upload, retry, offline disk queue
  (queued reports send on next launch).
- `ReportPayload.cs` — hand-rolled JSON of device/build/session metadata.

**GamesPanda integration:** `Assets/BugReporterBoot.cs` in the RituGames client initializes the SDK
with `Enabled = ConstantsData_M.MpVerboseLogs` (dev-only). Note the boot script must exist in the
BUILD you hand testers — in-editor presence isn't enough for the Android build (rebuild after adding).

## 3b. Flutter SDK

`flutter-sdk/bug_reporter` is a Flutter package that sends the same reports as the Unity SDK (same
`/api/report` multipart fields: `report` JSON, `logs`, `screenshot`, `thumbnail`, `clip`), so the dashboard
needs no changes. Setup is `BugReporter.init(...)` plus `BugReporterOverlay` in `MaterialApp.builder`;
screenshots come from a RepaintBoundary around the app, JPEG encoding runs in a background isolate.
Install, options and usage: [flutter-sdk/bug_reporter/README.md](flutter-sdk/bug_reporter/README.md).

## 4. cPanel deployment (current) — https://pandabugsreporting.com

Moved off Wasmer on 2026-09-14 as a **fresh start** (no issues/uploads migrated). Runs on the GoDaddy
WHM/cPanel server (AlmaLinux 10, `97.74.90.109`), cPanel account `pandabugsreporti`, as a **Passenger
Python app** (EasyApache 4 `mod_passenger`, `/usr/bin/python3.12`).

| Where | What |
|---|---|
| `/home/pandabugsreporti/bugreporter/` | app root — `passenger_wsgi.py` (this repo's root file), `requirements.txt`, `backend/` (app + built `static/`) |
| `…/bugreporter/.env` | config: `DB_*`, `BR_INVITE_CODE`, `BR_DELETE_CODE` — mode 0600, **outside public_html** |
| `…/bugreporter/tmp/restart.txt` | save/touch it to restart the app (Passenger convention) |
| `…/bugreporter/logs/app.log` | the app's own log: boot lines + one line per request (path/status/timing). Apache's error_log is root-only, so this is what you have |
| `/home/pandabugsreporti/bugreporter_data/uploads/` | `BR_UPLOAD_DIR` — screenshots / logs / clips |
| `public_html/` | nothing app-related; Passenger answers `/` for the whole domain |
| `/home/pandabugsreporti/old_deploy_aug29/` | the abandoned Aug-29 Docker attempt, moved out of `public_html` (it had been world-readable, `.env` included). Safe to delete |

- Registered with cPanel UAPI `PassengerApps/register_application` (name `bugreporter`, path `bugreporter`,
  domain `pandabugsreporting.com`, base URI `/`). The account's feature list does **not** expose
  *Application Manager* in the cPanel menu, so config lives in `.env` — `passenger_wsgi.py` loads it at
  boot; real environment variables (if ever set) still win.
- Python deps go to the user's `~/.local/lib/python3.12/site-packages` via
  `PassengerApps/ensure_deps?type=pip&app_path=bugreporter` (reads the app root `requirements.txt`).
- MySQL: MariaDB 10.11 on `localhost`, database `pandabugsreporti_db`, user `pandabugsreporti_user`
  (cPanel → Manage My Databases). The password exists only in `.env`. Schema is created on first boot.
- **Deploying a change:** push to `main`, then cPanel → *Git™ Version Control* → the
  `BugReporterUnity` clone → *Manage* → *Pull or Deploy* → **Update from Remote**, then **Deploy HEAD
  Commit**. `.cpanel.yml` copies `backend/{app,tester_static,static,main.py}`, `passenger_wsgi.py`,
  `main.py`, `requirements.txt` into `…/bugreporter/` and touches `tmp/restart.txt`. (Manual fallback:
  put the files there yourself and save `tmp/restart.txt`.) Dashboard changes = `npm run build` and
  commit `backend/static/` first.

### Gotchas that cost time here
1. **`/api` proxy loop, server-wide.** WHM → Apache Configuration → Include Editor → *Pre Main Include*
   still held `ProxyPass /api http://pandabugsreporting.com/api` from the Docker attempt — Apache
   proxying to **itself**. Every `/api/*` request on *every* domain looped until 502; Apache then served
   its `/502.shtml` error page *through Passenger*, which the SPA fallback answered with `index.html`
   (so `/api/health` "returned the dashboard"), and the loop tied up workers until even TLS handshakes
   stalled. Removed 2026-09-14. Keep that include empty unless you know exactly why.
2. Passenger reads `.env` only at boot — after editing it, save `tmp/restart.txt`.
3. First check `/api/health`, then `logs/app.log`.

## 4b. Wasmer deployment (legacy)

- **App:** `bugreporterunity`, owner `aqibshabbirdev`, python preset, auto-deploys from this GitHub
  repo's default branch. **Push to deploy.**
- **`app.yaml` is load-bearing:**
  ```yaml
  kind: wasmer.io/App.v0
  name: bugreporterunity
  owner: aqibshabbirdev
  app_id: da_K0DIkt5UxL18
  volumes:
    - name: data
      mount: /data
  ```
  ⚠️ Deleting this file once **detached the `/data` volume and lost uploads**. The `app_id` pins the
  deploy to the existing app; `volumes` keeps screenshots/logs persistent across deploys.
- **Uploads** go under `/data` (`UPLOAD_ROOT`). Everything else is stateless.
- **Managed MySQL** is a Wasmer add-on (Databases tab). Credentials are injected as env vars — never
  hardcode them.

### Environment variables (set in the Wasmer app settings)
| Var | Purpose |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USERNAME` / `DB_PASSWORD` | injected by the Wasmer MySQL add-on |
| `BR_DB_*` variants / `DB_URL` / `DB_USER` | accepted fallbacks in `db.py` (checked in that order) |
| `BR_INVITE_CODE` | registration is invite-only; a would-be dashboard user needs this code |
| `BR_DELETE_CODE` | confirm password for deleting an issue (dashboard → issue → Danger zone). Defaults to `Queen@21`; set a private value here |
| `BR_RETAIN_CLIP_DAYS` | clips are purged after this many days (default 7) — see §8 |
| `BR_RETAIN_DAYS` | screenshots/thumbs/logs are purged after this many days (default 30) |

### WASIX gotchas (cost us real debugging time)
1. `import pymysql` calls `getpass.getuser()` → **OSError on WASIX** unless a `USER` env var exists.
   `db.py` does `os.environ.setdefault("USER", "wasix")` before the import. Don't remove it.
2. Keep imports **lazy** and route failures into `DB_INIT_ERROR` — an import-time crash on Wasmer
   yields an opaque 500 with no logs. `/api/health` reports `db_env_vars_present` + the captured
   init error for exactly this reason. Check it first when anything 500s.
3. `pw_hash` column is `VARCHAR(200)` — werkzeug scrypt hashes are ~161 chars; the original 160
   truncated them and **every login failed** ("wrong email or password" on correct creds).

### Schema migrations
`CREATE TABLE IF NOT EXISTS` never alters an existing table, so any **column added after the first
deploy** goes in `db._migrate()` (runs every boot; each step must be idempotent). It checks
`information_schema` before `ALTER` because MySQL — unlike MariaDB — has no `ADD COLUMN IF NOT EXISTS`.
The `issues.game` column (per-game filtering) landed this way; existing rows backfill to `''`.

## 5. Backend API surface

Ingest (API-key auth via `X-Api-Key`):
- `POST /api/report` — multipart: `meta` (JSON), `screenshot` (jpeg, ≤2 MB, magic-checked),
  `logs` (text, ≤512 KB). Rate limit: 30 reports/min per key (in-process — fine single-instance).

Dashboard (session cookie; scrypt-hashed passwords; invite-code registration):
- `POST /api/auth/register` (needs `BR_INVITE_CODE`) / `login` / `logout`, `GET /api/auth/me`
- `GET /api/export` — **API-key auth (X-Api-Key)**, not session. For QA tooling/CI: returns the project's
  issues incl. `test_case` and `tester_note`. Filters: `?status=`, `?game=`, `?since=<unix>`, `?with_test_case=1`.
  Example: `curl -H "X-Api-Key: br_live_…" https://pandabugsreporting.com/api/export?with_test_case=1`
- `GET|POST /api/projects`, `POST /api/projects/<pid>/rotate-key`
- `GET /api/projects/<pid>/issues` — filters: `?build=`, `?game=`, `?status=`
- `GET /api/projects/<pid>/builds`, `GET /api/projects/<pid>/games` (games with issue/open counts, for the filter)
- `GET|PATCH /api/issues/<iid>` — detail includes `siblings` (other reports in the same session).
  PATCH body is `{status, fixedInBuild?}` — see §5.1. `POST /api/issues/<iid>/comments`
- `GET /api/issues/<iid>/screenshot.jpg`, `GET /api/issues/<iid>/logs.txt`
- `GET /api/health` — DB/env diagnostics

### 5.1 Issue status workflow

Every report moves through four states, in this order:

| Status | Means | Who moves it |
|---|---|---|
| `open` | Reported, nobody on it yet | — (every new report lands here) |
| `pending` | Someone is working on it | dev, when they pick it up |
| `waiting_for_test` | Fix is in a build — needs a retest | dev, with the build number |
| `closed` | Retested and done | tester |

- **The build stamp.** `fixed_in_build` is set when you move an issue to `waiting_for_test` and
  **survives the move to `closed`** — you still want to know which build carried the fix months later.
  Moving back to `open`/`pending` clears it, because the fix no longer stands. (The original PATCH
  rewrote that column on *every* status change, so closing an issue silently erased it.)
- **"Unresolved" ≠ `open`.** The `open_count` on `/builds` and `/games`, the Unresolved tile and the
  per-game pill all mean *not closed* — a pending or waiting-for-test issue still needs someone. Only
  the `Open` tab means the literal `open` state.
- **Dashboard:** a row of filter tabs above the issues list, each with a live count. Filtering happens
  in the browser off one fetch, so the counts are true facet counts (they show what each tab *would*
  show) and switching tabs costs no round trip.
- **Legacy values** (`fixed_in_build` / `verified` / `wont_fix`, the original set) are remapped on boot
  by `db._migrate` → `waiting_for_test` / `closed` / `closed`. Plain idempotent UPDATEs, no column
  change. `wont_fix` and `verified` both collapse into `closed` — if you need "won't fix" back as a
  distinct state, add it to `api.STATUSES` and `dashboard/src/status.ts` and it appears everywhere.
- **Adding or renaming a state** is two edits: `STATUSES` in `backend/app/api.py` and
  `dashboard/src/status.ts` (order, labels, hints). The tabs, badges and picker all read from there.

## 6. Dashboard

React + Vite + TS in `dashboard/`. Pages: Login, Projects, Issues (status tabs + date/game/build
filters), IssueDetail (screenshot + log viewer + comments + status picker), Settings (API key + rotate).

Build & ship (the built output is **committed** so Wasmer needs no node step):
```bash
cd dashboard && npm install && npm run build   # outputs into ../backend/static
git add ../backend/static && git commit && git push   # push = deploy
```

## 6a. Teams — one app, separate data per team

Every account belongs to one team (`users.team_id`), and so does every project (`projects.team_id`) and
API-tester document (`tester_docs.team_id`). Issues, builds, attachments, comments and test marks belong to
a team through their project or collection. Every dashboard and tester endpoint filters by the signed-in
user's team; another team's id answers **404** (not 403), so ids can't be probed. The report endpoint
needs no change — the API key already names the project, and the project names the team.

- **Joining:** register with an invite code from `team_invites`. A team admin makes codes on the dashboard's
  **Team** page (top-bar chip), picks whether the code joins as dev or admin, and can revoke it. The very
  first account on an empty database creates the first team. The old `BR_INVITE_CODE` still works and
  joins the first team as a dev.
- **Owner:** `users.is_owner` (the oldest admin when teams were introduced). The owner can create teams on
  the Team page and gets that team's first **admin** invite code. The owner is not a member of teams it
  creates and sees only their names and member/project counts.
- **Team admins** can rename the team, change members' roles and remove members (their sessions end at once).
- **Migration:** `db._migrate` adds the columns, puts every pre-existing row in a team named
  `BR_DEFAULT_TEAM_NAME` (default "Games Panda"), and marks the oldest admin as owner. It also normalises
  every table to `utf8mb4_unicode_ci`, because cross-table team joins fail on mixed collations.
- Retention rules (and "Clean up now") are the same for every team; the storage figure counts only your
  team's projects.

## 6b. API tester — `/apitestingbruno`

A small Postman-style page for the team's API collections, on the same app and sign-in as the dashboard
(`https://pandabugsreporting.com/apitestingbruno`). Plain JS, no build step — the files in
`backend/tester_static/` are served as-is, so deploying a change is copying them.

- **Storage:** one `tester_docs` row per collection/environment, holding the **Postman v2.1 JSON document
  itself** (`backend/app/tester.py`). The page edits it in place; unknown fields survive; Export returns a
  file Postman opens. Deleting a collection or environment is admin-only.
- **Several people at once:** saves carry a `version`; a stale save gets 409 and the page three-way merges
  its edits onto the newer version (`M.merge3` in `model.js`), matching requests and folders by their `id`
  (the server gives every item one). Different requests, or different parts of one request (body, headers,
  URL, each script), merge silently; only a field both people changed asks "keep mine / keep theirs".
  Environments merge per variable (same variable changed on both sides: the saver's value wins). Every 12s
  the page checks versions: with nothing unsaved it loads the newer collection in place, otherwise a banner
  offers "Merge now". A page loaded before ids existed can't save (400, "reload") — its id-less items would
  look like a full delete-and-re-add to everyone else.
- **Test marks:** every request is *Pending* until a tester marks it *Verified* (✓) or *Not working* (✕, with an
  optional note). Marks live in `tester_marks` (collection id + item id), not in the collection document, so a
  mark saves at once, never bumps the version and never needs a merge. The tree shows each request's mark and
  per-folder counts, the sidebar filters by status, and the 12s poll picks up teammates' marks. Each mark keeps
  who, when and the HTTP status of the last response on that page.
- **Runner:** "▶ Run folder" (folder page or its ⋯ menu; "Run whole collection" in the collection menu) sends a
  folder's requests in tree order with their scripts, so a login request early in the folder fills the token
  for the rest. Requests that spend coins, delete, start a game, change an account or send an OTP start
  unticked (`T.riskOf` in `panels.js`, name + URL patterns); logins are always ticked. Results are judged by
  `T.judge`: the request's own `pm.test`s if it has any, otherwise HTTP 2xx and — for CardGames, which always
  answers 200 — a body `code` of 200 and no `status: false`. Pass → ✓, fail → ✕ with an "Auto run: …" note;
  a request whose URL or Authorization header uses an empty variable is skipped, not marked.
  A folder named "Flows" (or inside one) is a scripted scenario: every step is ticked and the run stops at the
  first failure. The collection's "🧪 Flows — game money checks" folder logs in two test accounts, plays a
  vs-AI loss + win (silver) and a multiplayer win/loss + draw (gold, settled through the game-server endpoints)
  and asserts the balance after each result with `pm.test`. Run-time tokens and ids go in `pm.variables`
  (this page only), so testers running at once don't collide.
- **Page:** `index.html` + `model.js` (Postman document helpers, `{{variable}}` resolution, auth inheritance,
  a `pm.*` script sandbox covering pm.environment/collectionVariables/variables, pm.request.headers,
  pm.response, pm.test, pm.expect) + `app.js` (sign-in, tree, editor) + `panels.js` (send, response,
  dialogs, import/export, find & replace in URLs).
- **Sending:** "Send from my browser" does a plain `fetch` (needed for localhost/LAN APIs; subject to CORS).
  "Send via server" posts to `/api/tester/send` (`backend/app/tester_send.py`), which refuses anything not
  globally routable — loopback, private ranges, link-local/metadata — and this machine's own IP (found from
  its hostname; `TESTER_BLOCKED_IPS` adds more). It connects to the address it checked (no DNS rebinding),
  never follows redirects, times out at 30s and caps responses at 10 MB. 120 sends/min per user.
- Scripts in a collection run in the viewer's browser, like Postman runs them — treat a shared collection
  as trusted team content.

## 7. Tester instructions (forwardable)

1. Game mein kahin bhi bug dikhe → screen ke corner par **Report** button dabao.
2. Chhota sa note likho (kya kar rahe the, kya galat hua) → **Send**.
3. Screenshot + logs + device/build info khud attach ho jate hain — kuch aur nahi karna.
4. Net na ho to report queue ho jati hai aur agli baar game kholne par chali jati hai.

Dashboard access needs an account — registration requires the invite code (`BR_INVITE_CODE` env).

## 8. Operational notes / security TODOs

- **Rotate the project API key** (dashboard → Settings → Rotate) — the original key appeared in a
  chat transcript during development. Owner deferred rotation during testing; do it before wider use.
- **Rotate the MySQL credentials** (Wasmer → Databases → Rotate Credentials) — same reason.
- **Retention** (`backend/app/retention.py`): nothing else in the system prunes bytes, and a full `/data`
  volume makes uploads fail *silently*. Two tiers — clips (the whale, ~3-6 MB each) go after
  `BR_RETAIN_CLIP_DAYS` (7), the rest of an issue's attachments after `BR_RETAIN_DAYS` (30). The issue
  **row is never deleted** — only its evidence; `has_screenshot`/`has_logs`/`has_clip` are cleared as files
  go, so the UI renders its normal "no attachment" states. There's no scheduler here, so the purge runs off
  the ingest path (throttled to once an hour) — growth and cleanup stay coupled — plus a **Clean up now**
  button and live usage figure in dashboard → Settings → Storage (`GET /api/storage`,
  `POST /api/storage/cleanup`, admin).
- The in-process rate limiter resets on redeploy and doesn't share across instances — fine for the
  current single-instance free tier; revisit if scaled.
- `backend/.venv/` is local-only convenience; it should stay untracked.

## 9. Troubleshooting quick table

| Symptom | Check |
|---|---|
| Everything 500s | `GET /api/health` → `DB_INIT_ERROR`, `db_env_vars_present` |
| Login fails with correct creds | `pw_hash` column length (≥200) — see §4.3 |
| SDK 401 | key prefix `br_` exact (no typos), key matches the dashboard project, key not rotated |
| Uploads vanish after deploy | `app.yaml` volumes block intact? (§4) |
| No Report button on device | SDK `Enabled` flag + the boot script actually in that BUILD |
| Registration rejected | `BR_INVITE_CODE` env set and code matches |

## 10. State

**2026-09-14 — moved to cPanel (§4).** `https://pandabugsreporting.com` serves the dashboard + API from
the GoDaddy WHM server; DB is a fresh MariaDB schema, so the first dashboard registration becomes admin
and a new project/API key must be created. The GamesPanda client (`ApiAndRoomManager.cs`) needs the new
`Endpoint` + that new key. Wasmer stays up untouched with the old data. Housekeeping still open: rotate
the server root password (was shared in chat), stop the leftover Docker container on `:8000`, delete
`~/old_deploy_aug29/` once nothing in it is needed, set a private `BR_DELETE_CODE`/`BR_INVITE_CODE` in `.env`.

### As of 2026-07-27

- Deployed and working end-to-end: SDK → ingest → MySQL → dashboard.
- Integrated in the GamesPanda client (dev-gated); tested from Unity editor and Android.
- **Per-game separation** (auto scene→game / `game` column / dashboard game filter) and **warning exclusion**
  (`IncludeWarnings`, default off) added 2026-07-14 — one API key across ~10 games no longer mixes issues,
  and log buffers aren't drowned in warnings. The game is derived from the active scene's `_Games/<Folder>/`
  path with no per-game wiring (`SetGame` is an optional override). Backend needs a redeploy (auto `issues.game`
  migration on boot); testers need a rebuilt client (any build with the updated SDK).
- **Issue status workflow** (open → pending → waiting_for_test → closed) added 2026-07-27, replacing
  the original open/fixed_in_build/verified/wont_fix set — see §5.1. Backend needs a redeploy; the
  boot migration remaps existing rows, so no manual DB work. No SDK/client change.
- Open items: key + DB credential rotation (§8); dashboard invite for additional testers
  (set/share `BR_INVITE_CODE`); optional niceties from PLAN.md (email notify, issue dedup rules).
