# Game-Dev Bug Reporting Tool — MVP Plan

Working name: **BugReporterUnity**
One-liner: *In-game bug reporting for game teams. Tester presses a button; you get a ticket with the screenshot, the logs, and the build it happened on.*

---

## 1. Why this wedge

Generic trackers (Jira, Linear, Trello) and even game-flavoured boards (HacknPlan, Codecks) all start at the **ticket**. The pain in a real game team is *before* the ticket:

- Tester finds a bug → describes it in WhatsApp/Discord in prose
- Dev asks: which build? send logs. send a video. what over was it?
- Logs live on the tester's device; nobody has the state at the moment of the bug
- By the time it's a ticket, half the evidence is gone

**We collapse that gap.** The report is created *inside the running game*, with evidence attached automatically. Everything else (boards, sprints) is deliberately out of scope — we sit alongside Jira/Linear, we don't replace them.

Validation asset: we dogfood on GamesPanda (Unity, Mirror MP, a real QA cycle with a real tester).

---

## 2. MVP scope

### In
1. **Unity SDK** (UPM package)
   - Floating report button in dev builds
   - Auto-captures: screenshot, device info, build version, last N log lines, custom metadata
   - Tester types one line → submits
2. **Web dashboard**
   - Issue list, filterable **by build** (the key view: "what's new in build #52")
   - Issue detail: screenshot, searchable log viewer, device info
   - Status flow: `open → fixed_in_build → verified` (+ `wont_fix`)
   - One project, invite teammates (roles: `admin`, `dev`, `tester`)
3. **Build registry** — a build row auto-created on first report carrying that version

### Out (v2+)
Video capture · Unreal / Godot SDKs · Unity editor plugin · boards, sprints, estimates · Jira/Slack/Discord integrations · billing · analytics dashboards · multi-org

Cutting these is what makes 4–6 weeks real.

---

## 3. Architecture

```
Unity game (dev build)
  │  POST /report   (project API key, multipart: json + screenshot)
  ▼
Cloud Function  ── validates key, rate-limits, uploads to Storage,
  │                writes Firestore doc, upserts build row
  ▼
Firestore + Storage
  ▲
  │  Firebase Auth (email/Google) + security rules (read/write by project membership)
Dashboard (React + Vite + TS)
```

**Key decision:** the Unity SDK **never touches Firestore directly**. Shipping Firebase credentials in a game binary is a leak. It posts to a Cloud Function with a per-project **API key** (safe to embed — write-only, rate-limited, revocable). The dashboard uses Firebase Auth + rules normally.

### Stack
| Layer | Choice | Why |
|---|---|---|
| Dashboard | React + Vite + TypeScript + Tailwind | fast, you know it |
| Backend | Firebase (Auth, Firestore, Storage, Functions) | zero ops for MVP |
| SDK | Pure C#, `UnityWebRequest`, no deps | drops into any Unity 2020+ project |

**Prereq:** Node 18+ (you're on 16.20.2 — Vite 5 and Firebase Functions v2 need 18+). `nvm install 20`.

---

## 4. Data model (Firestore)

```
projects/{projectId}
  name, engine: "unity", createdAt, ownerUid
  apiKeyHash          # store the hash, show the key once at creation

projects/{projectId}/members/{uid}
  role: "admin" | "dev" | "tester", email, joinedAt

projects/{projectId}/builds/{buildId}         # buildId = the version string, slugified
  version: "0.9.52", platform: "Android",
  firstSeenAt, reportCount

projects/{projectId}/issues/{issueId}
  title                    # tester's one line
  description              # optional longer text
  status: "open" | "fixed_in_build" | "verified" | "wont_fix"
  fixedInBuild?: "0.9.53"
  buildVersion: "0.9.52"   # build it was REPORTED on
  platform, deviceModel, osVersion, screenResolution, memoryMB
  screenshotPath           # Storage path
  logPath                  # Storage path (plain text)
  metadata: {}             # game-supplied: { innings: 2, over: "2.4", reconnects: 1 }
  reporterName, createdAt, updatedAt

projects/{projectId}/issues/{issueId}/comments/{commentId}
  authorUid, text, createdAt
```

**Storage:** `projects/{projectId}/issues/{issueId}/screenshot.jpg`, `.../logs.txt`

### Security rules (shape)
- `projects/{p}/**` readable+writable only by members of `p` (membership doc exists)
- Storage mirrors the same check
- Ingest path bypasses rules entirely — Functions use the Admin SDK after validating the API key

---

## 5. Unity SDK surface

```csharp
// Boot once, e.g. in a RuntimeInitializeOnLoadMethod
BugReporter.Init(new BugPandaConfig {
    ApiKey     = "br_live_xxx",
    Endpoint   = "https://us-central1-<proj>.cloudfunctions.net/report",
    BuildVersion = Application.version,   // or your own build number
    Enabled    = Debug.isDebugBuild,      // never ships in release
    LogBufferSize = 200,
});

// Attach live game state to whatever gets reported next
BugReporter.SetMetadata("innings", CONTROLLER.currentInnings);
BugReporter.SetMetadata("over", GameData.instance.GetOverStr());

// Optional: report without the UI (e.g. from an exception handler)
BugReporter.Report("Auto: NullReference in GroundController", severity: Severity.Crash);
```

**Internals**
- `Application.logMessageReceived` → ring buffer of last N lines (cheap, allocation-light)
- Report button: `OnGUI` overlay OR a small prefab canvas — same zero-setup pattern as the FPSDisplay script (auto-spawn via `RuntimeInitializeOnLoadMethod`, `DontDestroyOnLoad`)
- Screenshot: `ScreenCapture.CaptureScreenshotAsTexture()` → JPEG encode (quality 60) on a worker thread
- Submit: multipart `UnityWebRequest`, retry ×3 with backoff, queue to disk if offline and flush on next launch
- Hard rule: **compiled out / disabled in release builds**

---

## 6. Dashboard screens (5 total)

1. **Login** — Firebase Auth (Google + email)
2. **Project list / create** — creating a project shows the API key **once**
3. **Issues** — table: title, build, platform, status, reporter, age. Filters: build, status, platform. This is the money screen.
4. **Issue detail** — screenshot (click to zoom), metadata panel, **log viewer with search + highlight**, comments, status dropdown (+ "fixed in build" picker)
5. **Settings** — members + invite, regenerate API key, SDK snippet to copy-paste

---

## 7. Milestones (4–6 weeks, part-time)

| Wk | Deliverable | Done when |
|---|---|---|
| 1 | Repo scaffold, Firebase project, Auth + project creation + API keys | you can log in and create a project, key shown once |
| 2 | Ingest Function + Firestore/Storage writes + rules | `curl` a fake report → it appears in Firestore |
| 3 | Unity SDK: log buffer, screenshot, submit, retry/offline queue | GamesPanda dev build files a real report |
| 4 | Dashboard: issue list + build filter + issue detail + log viewer | Aqib files a bug, you debug it from the dashboard alone |
| 5 | Status flow, comments, members/invite, build registry view | one full cycle: report → fixed_in_build → verified |
| 6 | Polish: empty states, errors, offline queue flush, docs/README, SDK as a Git-URL UPM package | someone else's project can install it in 5 minutes |

**Milestone 0 (this week):** `nvm install 20`, create the repo, `firebase init`.

---

## 8. Repo layout

```
bugreporter-unity/
├─ dashboard/          # React + Vite + TS
│  ├─ src/{pages,components,lib,hooks}
│  └─ .env.local       # Firebase web config
├─ functions/          # Firebase Cloud Functions (TS)
│  └─ src/{report.ts,auth.ts,index.ts}
├─ unity-sdk/          # UPM package
│  └─ Packages/com.bugreporter.sdk/{Runtime,Editor,package.json}
├─ firestore.rules
├─ storage.rules
├─ firebase.json
└─ README.md
```

---

## 9. Risks & the honest answer to each

| Risk | Answer |
|---|---|
| "Why not just Jira + a Unity plugin?" | Nobody has shipped a good one, and the value is the *capture*, not the board. We integrate with Jira in v2 rather than fight it. |
| Screenshot/log upload cost | JPEG q60 (~100–300 KB) + text logs. Cheap. Add retention (auto-delete >90d) before any scale. |
| API key abuse | Write-only, rate-limited per key + per IP, revocable, dev-builds only. |
| Solo-dev bandwidth | Scope is brutally cut. Unreal/Godot only *after* one team other than yours uses it. |
| No market | You have a paying-attention user (your own QA) on day one. Ship, dogfood, then show it to 3 other studios before building v2. |

---

## 10. First decisions needed

1. **Name + domain** (bugpanda? something else)
2. Repo public or private
3. Do we want anonymous tester access (tester submits without an account)? → **Yes for MVP**, that's the whole point of the API key.
