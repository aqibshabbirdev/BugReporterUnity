# Bug Reporter

In-game bug reporting for game teams. A tester presses a button; you get a ticket with the screenshot,
the last 200 log lines, the device, and the build it happened on.

Not a replacement for Jira or Linear — it fixes what happens *before* the ticket exists.

## Layout

| Path | What |
|---|---|
| `unity-sdk/` | Unity package (`com.bugreporter.sdk`) — the in-game reporter |
| `functions/` | Firebase Cloud Functions — the ingest endpoint |
| `dashboard/` | React + Vite dashboard — issues, builds, logs |

See [PLAN.md](PLAN.md) for scope, data model and milestones.

## Unity SDK — quick start

Install via Package Manager → *Add package from git URL*:

```
https://github.com/aqibshabbirdev/BugReporterUnity.git?path=unity-sdk/Packages/com.bugreporter.sdk
```

Then, once at boot:

```csharp
[RuntimeInitializeOnLoadMethod]
static void InitBugReporter()
{
    BugReporter.BugReporter.Init(new BugReporter.BugReporterConfig {
        ApiKey   = "br_live_xxx",
        Endpoint = "https://us-central1-<project>.cloudfunctions.net/report",
        Enabled  = Debug.isDebugBuild,   // never ships in release
    });
}
```

Attach whatever game state makes a report useful:

```csharp
BugReporter.BugReporter.SetMetadata("innings", currentInnings);
BugReporter.BugReporter.SetMetadata("over", "2.4");
```

That's the whole integration. The floating button, the screenshot, the log buffer, retry and the
offline queue are handled for you.

## Status

Week 1 of the [MVP plan](PLAN.md). Unity SDK runtime is in; Functions and dashboard are next.
