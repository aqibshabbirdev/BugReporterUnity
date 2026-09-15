/// Settings handed to [BugReporter.init]. Everything has a default except [apiKey] and [endpoint], which
/// identify the dashboard project the reports land in.
class BugReporterConfig {
  const BugReporterConfig({
    required this.apiKey,
    required this.endpoint,
    this.enabled = true,
    this.buildVersion,
    this.gameId,
    this.logBufferSize = 200,
    this.captureDebugPrint = true,
    this.showReportButton = true,
    this.screenshotQuality = 60,
    this.screenshotMaxSide = 1440,
    this.queueFailedReports = true,
    this.recordClip = false,
    this.clipSeconds = 10,
    this.clipFps = 4,
    this.clipMaxWidth = 360,
    this.clipQuality = 50,
    this.clipMaxBytes = 8 * 1024 * 1024,
  });

  /// The project's key from the dashboard (Settings → Rotate API key). Starts with `br_`.
  final String apiKey;

  /// The ingest URL, e.g. `https://pandabugsreporting.com/api/report`.
  final String endpoint;

  /// Master switch. Keep it off in store builds, e.g. `enabled: !kReleaseMode` or a
  /// `--dart-define=BUG_REPORTER=true` flag for tester APKs. When false nothing is hooked or drawn.
  final bool enabled;

  /// Shown on every issue. Defaults to the app's `version+buildNumber`.
  final String? buildVersion;

  /// Which game/section the tester is in at start; change it at runtime with [BugReporter.setGame].
  final String? gameId;

  /// How many of the most recent log lines travel with a report.
  final int logBufferSize;

  /// Copy `debugPrint` output into the log buffer. Errors (FlutterError and uncaught async errors) are
  /// always captured; plain `print` is captured when the app runs inside [BugReporter.runGuarded].
  final bool captureDebugPrint;

  /// Draw the draggable "🐞 Report" button. Turn off to trigger [BugReporter.report] from your own UI —
  /// keep [BugReporterOverlay] in the tree either way, it is what screenshots are taken from.
  final bool showReportButton;

  /// JPEG quality (1–100) of the attached screenshot.
  final int screenshotQuality;

  /// The screenshot's longest side in pixels; a larger screen is scaled down to this.
  final int screenshotMaxSide;

  /// Reports that can't be sent (offline, server down) are saved and retried on the next launch.
  final bool queueFailedReports;

  /// Keep a rolling clip of the last [clipSeconds] as small JPEG frames and attach it to reports. Off by
  /// default: frames are captured and encoded continuously, which costs CPU and battery — tester builds only.
  final bool recordClip;

  final int clipSeconds;

  /// Frames per second (1–10). JPEG encoding runs in Dart, so keep this low on older phones.
  final int clipFps;

  /// Clip frame width in pixels; the height follows the screen's aspect ratio.
  final int clipMaxWidth;

  /// JPEG quality (1–100) of clip frames.
  final int clipQuality;

  /// Hard cap on the uploaded clip. The oldest frames are dropped to fit, so the moments just before the
  /// report are kept and the report never becomes too large for the server.
  final int clipMaxBytes;
}
