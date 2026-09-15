# bug_reporter (Flutter)

The Flutter SDK for the Bug Reporter dashboard — the same reports as the Unity SDK. Testers tap a floating
**🐞 Report** button, optionally type a note, tap a category, and the dashboard gets:

- a screenshot of the app (the button and form are never in it) plus a small thumbnail for the issue grid
- the last 200 log lines: `debugPrint`, Flutter framework errors, uncaught async errors, and `print` when
  the app runs inside `BugReporter.runGuarded`
- build version, platform, device model, OS version, screen size, RAM (Android)
- the current route, the game set with `setGame`, the match id set with `setSession`, and your `setMetadata` values
- optionally, a rolling clip of the last few seconds

Sending retries three times; a report that still can't be delivered (offline) is saved and sent on the
next launch. Android, iOS and desktop. Not web.

## Install

```yaml
dependencies:
  bug_reporter:
    git:
      url: https://github.com/aqibshabbirdev/BugReporterUnity.git
      path: flutter-sdk/bug_reporter
      ref: main
```

Android release builds need internet permission in `android/app/src/main/AndroidManifest.xml`
(debug builds already have it):

```xml
<uses-permission android:name="android.permission.INTERNET"/>
```

## Set up (three lines)

```dart
import 'package:bug_reporter/bug_reporter.dart';
import 'package:flutter/foundation.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BugReporter.init(const BugReporterConfig(
    apiKey: 'br_live_...',                                   // dashboard → project → Settings
    endpoint: 'https://pandabugsreporting.com/api/report',
    enabled: !kReleaseMode || bool.fromEnvironment('TESTER_BUILD'),
  ));
  BugReporter.runGuarded(() => runApp(const MyApp()));      // or plain runApp(...)
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        builder: (context, child) => BugReporterOverlay(child: child!),   // 1. button + screenshots
        navigatorObservers: [BugReporter.navigatorObserver],               // 2. route name on reports
        home: const HomePage(),
      );
}
```

Keep the reporter out of store builds. With the `enabled` line above, a tester APK is built with
`flutter build apk --dart-define=TESTER_BUILD=true` and a normal release build has no button and sends nothing.

Using `MaterialApp.router` or `CupertinoApp`? The same `builder:` line works there.

## While the app runs

```dart
BugReporter.setGame('Ludo');                 // groups reports per game on the dashboard
BugReporter.setSession(matchId);             // same id on every device in a match → one incident
BugReporter.setSession(null);                // when the match ends
BugReporter.setMetadata('table', 'VIP-3');   // small values: string / number / bool
BugReporter.log('socket reconnected');       // add your own log line

// Your own report button instead of the floating one (showReportButton: false):
final result = await BugReporter.report('Payment stuck', description: 'spinner forever', severity: Severity.high);
// result.outcome: sent / queued / rejected / failed / inactive
```

## Options (`BugReporterConfig`)

| Option | Default | |
|---|---|---|
| `enabled` | `true` | Master switch — gate it as shown above |
| `buildVersion` | app `version+buildNumber` | Shown on every issue |
| `gameId` | — | Starting game; change with `setGame` |
| `logBufferSize` | 200 | Lines kept |
| `captureDebugPrint` | `true` | Copy `debugPrint` into the logs |
| `showReportButton` | `true` | Floating draggable button |
| `screenshotQuality` / `screenshotMaxSide` | 60 / 1440 | JPEG quality / longest side in px |
| `queueFailedReports` | `true` | Save unsent reports for the next launch |
| `recordClip` | `false` | Rolling clip; costs CPU and battery — tester builds only |
| `clipSeconds` / `clipFps` / `clipMaxWidth` / `clipQuality` / `clipMaxBytes` | 10 / 4 / 360 / 50 / 8 MB | Clip settings |

The console shows `[BugReporter] …` lines for init and every send — including the endpoint, the masked key
and the server's answer — so "why didn't my report arrive?" is answered in the log.

## Tests

`flutter test` covers the log ring, the JSON fields, clip packing, retry / 413 / 4xx / offline-queue rules,
and the button → note → category flow.
