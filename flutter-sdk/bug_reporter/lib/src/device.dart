import 'dart:ui' as ui;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';

import 'payload.dart';

/// Device facts collected once at init (they don't change) — the screen size is re-read per report.
class DeviceInfoReader {
  DeviceSnapshot _base = const DeviceSnapshot();

  Future<void> load() async {
    final plugin = DeviceInfoPlugin();
    try {
      if (kIsWeb) {
        final w = await plugin.webBrowserInfo;
        _base = DeviceSnapshot(platform: 'Web', deviceModel: w.browserName.name, osVersion: w.platform ?? '');
      } else if (defaultTargetPlatform == TargetPlatform.android) {
        final a = await plugin.androidInfo;
        final ram = a.data['physicalRamSize'];
        _base = DeviceSnapshot(
          platform: 'Android',
          deviceModel: '${a.manufacturer} ${a.model}'.trim(),
          osVersion: 'Android ${a.version.release} (API ${a.version.sdkInt})',
          memoryMB: ram is int ? ram : 0,
        );
      } else if (defaultTargetPlatform == TargetPlatform.iOS) {
        final i = await plugin.iosInfo;
        _base = DeviceSnapshot(
          platform: 'iOS',
          deviceModel: '${i.model} (${i.utsname.machine})',
          osVersion: '${i.systemName} ${i.systemVersion}',
        );
      } else {
        _base = DeviceSnapshot(platform: defaultTargetPlatform.name);
      }
    } catch (_) {
      _base = DeviceSnapshot(platform: kIsWeb ? 'Web' : defaultTargetPlatform.name);
    }
  }

  DeviceSnapshot current() {
    var size = '';
    final views = ui.PlatformDispatcher.instance.views;
    if (views.isNotEmpty) {
      final s = views.first.physicalSize;
      size = '${s.width.round()}x${s.height.round()}';
    }
    return DeviceSnapshot(
      platform: _base.platform,
      deviceModel: _base.deviceModel,
      osVersion: _base.osVersion,
      screenResolution: size,
      memoryMB: _base.memoryMB,
    );
  }
}
