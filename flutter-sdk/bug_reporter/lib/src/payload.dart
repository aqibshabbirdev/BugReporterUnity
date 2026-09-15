import 'dart:convert';

/// The JSON part of a report — same fields the Unity SDK sends, so the dashboard treats both alike.
class ReportPayload {
  ReportPayload({
    required this.title,
    required this.description,
    required this.severity,
    required this.buildVersion,
    required this.game,
    required this.session,
    required this.scene,
    required this.device,
    required this.metadata,
    this.clipFps = 0,
  });

  final String title;
  final String description;
  final String severity;
  final String buildVersion;
  final String game;
  final String session;

  /// The current route name — the Flutter counterpart of Unity's scene path.
  final String scene;
  final DeviceSnapshot device;
  final Map<String, Object?> metadata;
  final int clipFps;

  String toJson() => jsonEncode({
        'title': title,
        'description': description,
        'severity': severity,
        'buildVersion': buildVersion,
        'game': game,
        'session': session,
        'scene': scene,
        'platform': device.platform,
        'deviceModel': device.deviceModel,
        'osVersion': device.osVersion,
        'screenResolution': device.screenResolution,
        'memoryMB': device.memoryMB,
        'clipFps': clipFps,
        'metadata': {for (final e in metadata.entries) e.key: _jsonSafe(e.value)},
      });

  static Object? _jsonSafe(Object? v) =>
      v == null || v is bool || v is num || v is String ? v : v.toString();
}

class DeviceSnapshot {
  const DeviceSnapshot({
    this.platform = '',
    this.deviceModel = '',
    this.osVersion = '',
    this.screenResolution = '',
    this.memoryMB = 0,
  });

  final String platform;
  final String deviceModel;
  final String osVersion;
  final String screenResolution;
  final int memoryMB;
}
