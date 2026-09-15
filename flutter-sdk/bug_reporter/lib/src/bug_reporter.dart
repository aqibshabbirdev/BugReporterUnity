import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'capture.dart';
import 'clip_recorder.dart';
import 'config.dart';
import 'device.dart';
import 'log_buffer.dart';
import 'payload.dart';
import 'sender.dart';

enum Severity { low, normal, high, crash }

enum ReportOutcome {
  /// Delivered to the dashboard.
  sent,

  /// Couldn't reach the server; saved and sent on the next launch.
  queued,

  /// The server refused it (usually a wrong API key) — see [ReportResult.message].
  rejected,

  /// Not delivered and not saved.
  failed,

  /// The reporter is off (disabled, or init hasn't run / failed).
  inactive,
}

class ReportResult {
  const ReportResult(this.outcome, {this.message = ''});
  final ReportOutcome outcome;
  final String message;
}

/// Entry point: call [init] once before `runApp`, put [BugReporterOverlay] in `MaterialApp.builder`, and
/// testers get a floating 🐞 Report button. Reports carry a screenshot, the recent log lines, device and
/// build info, the current route, and whatever [setMetadata] / [setGame] / [setSession] recorded.
class BugReporter {
  BugReporter._();

  static BugReporterConfig? _config;
  static LogBuffer? _logs;
  static ReportSender? _sender;
  static ClipRecorder? _clip;
  static final DeviceInfoReader _device = DeviceInfoReader();
  static final Map<String, Object?> _metadata = {};
  static String _game = '';
  static String _session = '';
  static String _route = '';
  static String _buildVersion = '';

  /// True once [init] succeeded with `enabled: true`. The overlay listens to this.
  static final ValueNotifier<bool> active = ValueNotifier(false);

  static bool get isActive => active.value;
  static BugReporterConfig? get config => _config;

  /// Tracks the current route name so reports say which screen the tester was on.
  static final NavigatorObserver navigatorObserver = _RouteTracker();

  static Future<void> init(BugReporterConfig config) async {
    if (_config != null) {
      _say('init called twice — ignoring the second call.');
      return;
    }
    _config = config;
    if (!config.enabled) return;

    final apiKey = config.apiKey.trim(), endpoint = config.endpoint.trim();
    if (apiKey.isEmpty || endpoint.isEmpty) {
      _say('apiKey and endpoint are required — reporter stays off.');
      return;
    }
    if (!apiKey.startsWith('br_')) {
      _say("apiKey looks wrong ('${ReportSender.maskKey(apiKey)}') — it must start with br_. Reporter stays off.");
      return;
    }

    WidgetsFlutterBinding.ensureInitialized();
    _game = config.gameId?.trim() ?? '';
    _logs = LogBuffer(config.logBufferSize);
    _hookLogs(config);
    await _device.load();
    _buildVersion = config.buildVersion?.trim() ?? '';
    if (_buildVersion.isEmpty) {
      try {
        final info = await PackageInfo.fromPlatform();
        _buildVersion = info.buildNumber.isEmpty ? info.version : '${info.version}+${info.buildNumber}';
      } catch (_) {
        _buildVersion = 'unknown';
      }
    }

    _sender = ReportSender(
      endpoint: endpoint,
      apiKey: apiKey,
      queueDir: config.queueFailedReports && !kIsWeb ? _queueDir : null,
      log: _say,
    );
    unawaited(_sender!.flushQueue());

    if (config.recordClip) {
      _clip = ClipRecorder(
        seconds: config.clipSeconds, fps: config.clipFps, maxWidth: config.clipMaxWidth,
        quality: config.clipQuality, maxBytes: config.clipMaxBytes,
      )..start();
    }

    active.value = true;
    _say('Ready — build $_buildVersion, ${config.logBufferSize}-line log buffer, endpoint $endpoint, key ${ReportSender.maskKey(apiKey)}.');
  }

  static Future<Directory?> _queueDir() async {
    final base = await getApplicationSupportDirectory();
    return Directory('${base.path}/bugreporter-queue');
  }

  static void _hookLogs(BugReporterConfig config) {
    final previousFlutterError = FlutterError.onError;
    FlutterError.onError = (details) {
      _logs?.add('Error', '${details.exceptionAsString()}\n${details.stack ?? ''}'.trimRight());
      previousFlutterError?.call(details);
    };
    final dispatcher = WidgetsBinding.instance.platformDispatcher;
    final previousOnError = dispatcher.onError;
    dispatcher.onError = (error, stack) {
      _logs?.add('Exception', '$error\n$stack'.trimRight());
      return previousOnError?.call(error, stack) ?? false;
    };
    if (config.captureDebugPrint) {
      final previousPrint = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) {
        if (message != null) _logs?.add('Log', message);
        previousPrint(message, wrapWidth: wrapWidth);
      };
    }
  }

  /// Run the app inside a zone that also captures plain `print` calls and uncaught errors:
  /// `BugReporter.runGuarded(() => runApp(const MyApp()));`
  static void runGuarded(void Function() body) {
    runZonedGuarded(
      body,
      (error, stack) {
        _logs?.add('Exception', '$error\n$stack'.trimRight());
        FlutterError.presentError(FlutterErrorDetails(exception: error, stack: stack));
      },
      zoneSpecification: ZoneSpecification(print: (self, parent, zone, line) {
        _logs?.add('Log', line);
        parent.print(zone, line);
      }),
    );
  }

  /// Add a line to the log buffer yourself (e.g. from your own logger).
  static void log(String message, {String level = 'Log'}) => _logs?.add(level, message);

  /// Attach live app state to whatever gets reported next. Keep values small: string, number or bool.
  static void setMetadata(String key, Object? value) {
    if (key.isNotEmpty) _metadata[key] = value;
  }

  static void clearMetadata() => _metadata.clear();

  /// Tag every following report with the game/section the tester is in; the dashboard groups by it.
  static void setGame(String? gameId) => _game = gameId?.trim() ?? '';

  /// Tag every following report with the match/session id (the same id on every device in a multiplayer
  /// match) so reports from all devices show as one incident. Pass null when the match ends.
  static void setSession(String? sessionId) => _session = sessionId?.trim() ?? '';

  /// File a report: screenshot, logs, device info, then upload with retry (or save for later).
  static Future<ReportResult> report(String title, {String? description, Severity severity = Severity.normal}) async {
    final config = _config, sender = _sender;
    if (!isActive || config == null || sender == null) return const ReportResult(ReportOutcome.inactive);

    (Uint8List, Uint8List?)? shot;
    try {
      shot = await ScreenCapture.screenshot(quality: config.screenshotQuality, maxSide: config.screenshotMaxSide);
      if (shot == null) _say('No screenshot — is BugReporterOverlay in MaterialApp.builder? Sending without it.');
    } catch (e) {
      _say('Screenshot failed ($e) — sending the report without it.');
    }

    final clip = _clip?.packLatest();
    final payload = ReportPayload(
      title: title.trim().isEmpty ? '(no title)' : title.trim(),
      description: description?.trim() ?? '',
      severity: severity.name,
      buildVersion: _buildVersion,
      game: _game,
      session: _session,
      scene: _route,
      device: _device.current(),
      metadata: Map.of(_metadata),
      clipFps: clip != null ? _clip!.fps : 0,
    );

    final result = await sender.send(ReportParts(
      json: payload.toJson(),
      logs: _logs?.dump(),
      screenshot: shot?.$1,
      thumbnail: shot?.$2,
      clip: clip,
    ));
    return switch (result.status) {
      SendStatus.sent => ReportResult(ReportOutcome.sent, message: result.message),
      SendStatus.queued => ReportResult(ReportOutcome.queued, message: result.message),
      SendStatus.rejected => ReportResult(ReportOutcome.rejected, message: 'HTTP ${result.httpStatus}: ${result.message}'),
      SendStatus.failed => ReportResult(ReportOutcome.failed, message: result.message),
    };
  }

  static void _say(String message) {
    // Straight to the console: going through debugPrint would also copy these lines into the report's logs.
    debugPrintSynchronously('[BugReporter] $message');
  }

  @visibleForTesting
  static void debugReset() {
    _clip?.stop();
    _config = null;
    _logs = null;
    _sender = null;
    _clip = null;
    _metadata.clear();
    _game = _session = _route = _buildVersion = '';
    active.value = false;
  }

  @visibleForTesting
  static void debugActivate(BugReporterConfig config, ReportSender sender, {String buildVersion = 'test'}) {
    _config = config;
    _logs = LogBuffer(config.logBufferSize);
    _sender = sender;
    _buildVersion = buildVersion;
    active.value = true;
  }

  @visibleForTesting
  static String get debugRoute => _route;
}

class _RouteTracker extends NavigatorObserver {
  void _set(Route<dynamic>? route) {
    if (route is PageRoute) BugReporter._route = route.settings.name ?? route.runtimeType.toString();
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _set(route);
  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _set(newRoute);
  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => _set(previousRoute);
  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) => _set(previousRoute);
}
