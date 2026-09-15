import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:image/image.dart' as img;

/// Everything a screenshot or clip frame is taken from: the RepaintBoundary [BugReporterOverlay] puts around
/// the app. The report button and form sit outside it, so they never appear in the picture.
class ScreenCapture {
  static final GlobalKey boundaryKey = GlobalKey(debugLabel: 'BugReporter.capture');

  static RenderRepaintBoundary? get _boundary {
    final obj = boundaryKey.currentContext?.findRenderObject();
    return obj is RenderRepaintBoundary && obj.attached ? obj : null;
  }

  /// Raw RGBA pixels of the app with its longest side scaled to at most [maxSide] (or its width to
  /// [maxWidth]). Null when the overlay isn't mounted or the frame can't be read right now.
  static Future<RawFrame?> grab({int? maxSide, int? maxWidth}) async {
    final boundary = _boundary;
    if (boundary == null) return null;
    final size = boundary.size;
    if (size.isEmpty) return null;
    final view = WidgetsBinding.instance.platformDispatcher.views.first;
    double ratio = view.devicePixelRatio;
    if (maxSide != null) ratio = math.min(ratio, maxSide / math.max(size.width, size.height));
    if (maxWidth != null) ratio = math.min(ratio, maxWidth / size.width);
    ui.Image? image;
    try {
      image = await boundary.toImage(pixelRatio: ratio);
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) return null;
      return RawFrame(data.buffer.asUint8List(), image.width, image.height);
    } catch (_) {
      return null; // e.g. the boundary is mid-layout; the caller just goes without this frame
    } finally {
      image?.dispose();
    }
  }

  /// The screenshot and a ≤400px thumbnail for the dashboard grid, both JPEG, encoded off the UI thread.
  static Future<(Uint8List, Uint8List?)?> screenshot({required int quality, required int maxSide}) async {
    final frame = await grab(maxSide: maxSide);
    if (frame == null) return null;
    return compute(_encodeShotAndThumb, (frame, quality.clamp(1, 100)));
  }
}

class RawFrame {
  const RawFrame(this.rgba, this.width, this.height);
  final Uint8List rgba;
  final int width;
  final int height;
}

img.Image _toImage(RawFrame f) =>
    img.Image.fromBytes(width: f.width, height: f.height, bytes: f.rgba.buffer, bytesOffset: f.rgba.offsetInBytes, numChannels: 4);

/// Top-level so it can run in a background isolate.
Uint8List encodeJpeg((RawFrame, int) args) => img.encodeJpg(_toImage(args.$1), quality: args.$2);

(Uint8List, Uint8List?) _encodeShotAndThumb((RawFrame, int) args) {
  final full = _toImage(args.$1);
  final shot = img.encodeJpg(full, quality: args.$2);
  Uint8List? thumb;
  try {
    final longest = math.max(full.width, full.height);
    final small = longest > 400
        ? img.copyResize(full, width: full.width >= full.height ? 400 : null, height: full.height > full.width ? 400 : null)
        : full;
    thumb = img.encodeJpg(small, quality: 55);
  } catch (_) {
    thumb = null; // a missing thumbnail only makes the dashboard grid load the full screenshot
  }
  return (shot, thumb);
}
