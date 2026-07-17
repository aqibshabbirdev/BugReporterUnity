# Bug Reporter (Unity)

In-game bug reporting for game teams. A tester presses a button; you get a ticket with the
screenshot, the last log lines, the device, and the build it happened on — before anyone opens Jira.

**Live deployment:** https://bugreporterunity.wasmer.app (Wasmer app `bugreporterunity`, owner `aqibshabbirdev`)
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
        Endpoint = "https://bugreporterunity.wasmer.app/api/report",
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

## 4. Wasmer deployment

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
- `GET|POST /api/projects`, `POST /api/projects/<pid>/rotate-key`
- `GET /api/projects/<pid>/issues` — filters: `?build=`, `?game=`, `?status=`
- `GET /api/projects/<pid>/builds`, `GET /api/projects/<pid>/games` (games with issue/open counts, for the filter)
- `GET|PATCH /api/issues/<iid>` — detail includes `siblings` (other reports in the same session), `POST /api/issues/<iid>/comments`
- `GET /api/issues/<iid>/screenshot.jpg`, `GET /api/issues/<iid>/logs.txt`
- `GET /api/health` — DB/env diagnostics

## 6. Dashboard

React + Vite + TS in `dashboard/`. Pages: Login, Projects, Issues (list + build filter),
IssueDetail (screenshot + log viewer + comments + status), Settings (API key + rotate).

Build & ship (the built output is **committed** so Wasmer needs no node step):
```bash
cd dashboard && npm install && npm run build   # outputs into ../backend/static
git add ../backend/static && git commit && git push   # push = deploy
```

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

## 10. State as of 2026-07-14

- Deployed and working end-to-end: SDK → ingest → MySQL → dashboard.
- Integrated in the GamesPanda client (dev-gated); tested from Unity editor and Android.
- **Per-game separation** (auto scene→game / `game` column / dashboard game filter) and **warning exclusion**
  (`IncludeWarnings`, default off) added 2026-07-14 — one API key across ~10 games no longer mixes issues,
  and log buffers aren't drowned in warnings. The game is derived from the active scene's `_Games/<Folder>/`
  path with no per-game wiring (`SetGame` is an optional override). Backend needs a redeploy (auto `issues.game`
  migration on boot); testers need a rebuilt client (any build with the updated SDK).
- Open items: key + DB credential rotation (§8); dashboard invite for additional testers
  (set/share `BR_INVITE_CODE`); optional niceties from PLAN.md (email notify, issue dedup rules).
