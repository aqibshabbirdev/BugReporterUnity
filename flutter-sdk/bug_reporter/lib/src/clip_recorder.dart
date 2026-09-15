import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

import 'capture.dart';

/// Rolling buffer of the last few seconds of the app as small JPEG frames. A tick grabs a frame right
/// after the next paint and encodes it in a background isolate; a tick is skipped while the previous frame
/// is still encoding, so a slow phone gets fewer frames instead of a backlog.
class ClipRecorder {
  ClipRecorder({required int seconds, required int fps, required this.maxWidth, required this.quality, required this.maxBytes})
      : fps = fps.clamp(1, 10),
        _ring = List<Uint8List?>.filled((seconds < 1 ? 1 : seconds) * fps.clamp(1, 10), null);

  final int fps;
  final int maxWidth;
  final int quality;
  final int maxBytes;
  final List<Uint8List?> _ring;
  int _next = 0;
  bool _wrapped = false;
  bool _busy = false;
  Timer? _timer;

  void start() {
    _timer ??= Timer.periodic(Duration(milliseconds: 1000 ~/ fps), (_) => _tick());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  void _tick() {
    if (_busy) return;
    _busy = true;
    SchedulerBinding.instance.addPostFrameCallback((_) async {
      try {
        final frame = await ScreenCapture.grab(maxWidth: maxWidth);
        if (frame != null) push(await compute(encodeJpeg, (frame, quality.clamp(1, 100))));
      } catch (_) {
        // a skipped frame is fine
      } finally {
        _busy = false;
      }
    });
    SchedulerBinding.instance.ensureVisualUpdate();
  }

  @visibleForTesting
  void push(Uint8List frame) {
    _ring[_next] = frame;
    _next = (_next + 1) % _ring.length;
    if (_next == 0) _wrapped = true;
  }

  /// Oldest-to-newest frames packed as `[u32 count][u32 length × count][frame bytes…]` (little-endian) — the
  /// format the server unpacks. Trimmed from the oldest end to fit [maxBytes]; null when there is nothing.
  Uint8List? packLatest() {
    final all = <Uint8List>[];
    final count = _wrapped ? _ring.length : _next;
    final start = _wrapped ? _next : 0;
    for (var i = 0; i < count; i++) {
      final f = _ring[(start + i) % _ring.length];
      if (f != null) all.add(f);
    }
    if (all.isEmpty) return null;

    final budget = maxBytes < 256 * 1024 ? 256 * 1024 : maxBytes;
    var total = 4, first = all.length;
    for (var i = all.length - 1; i >= 0; i--) {
      final cost = all[i].length + 4;
      if (total + cost > budget) break;
      total += cost;
      first = i;
    }
    if (first >= all.length) return null;
    final frames = all.sublist(first);

    final out = BytesBuilder(copy: false);
    final header = ByteData(4 + 4 * frames.length)..setUint32(0, frames.length, Endian.little);
    for (var i = 0; i < frames.length; i++) {
      header.setUint32(4 + 4 * i, frames[i].length, Endian.little);
    }
    out.add(header.buffer.asUint8List());
    for (final f in frames) {
      out.add(f);
    }
    return out.takeBytes();
  }
}
