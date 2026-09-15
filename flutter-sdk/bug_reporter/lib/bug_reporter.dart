/// In-app bug reports for the Bug Reporter dashboard.
///
/// ```dart
/// Future<void> main() async {
///   WidgetsFlutterBinding.ensureInitialized();
///   await BugReporter.init(const BugReporterConfig(
///     apiKey: 'br_live_...',
///     endpoint: 'https://pandabugsreporting.com/api/report',
///   ));
///   runApp(MaterialApp(
///     builder: (context, child) => BugReporterOverlay(child: child!),
///     navigatorObservers: [BugReporter.navigatorObserver],
///     home: const HomePage(),
///   ));
/// }
/// ```
library;

export 'src/bug_reporter.dart' show BugReporter, ReportOutcome, ReportResult, Severity;
export 'src/config.dart' show BugReporterConfig;
export 'src/overlay.dart' show BugReporterOverlay;
