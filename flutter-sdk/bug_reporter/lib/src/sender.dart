import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// The pieces of one upload. The JSON goes in the `report` field; the rest are file parts.
class ReportParts {
  ReportParts({required this.json, this.logs, this.screenshot, this.thumbnail, this.clip});

  final String json;
  final String? logs;
  final Uint8List? screenshot;
  final Uint8List? thumbnail;
  Uint8List? clip;
}

enum SendStatus { sent, rejected, queued, failed }

class SendResult {
  const SendResult(this.status, {this.httpStatus, this.message = ''});
  final SendStatus status;
  final int? httpStatus;
  final String message;
}

/// Multipart POST to the ingest endpoint with the same rules as the Unity SDK: up to three attempts
/// (2s, 4s apart), a 413 retries without the clip, any other 4xx is final, and a report that still can't
/// be delivered is written to [queueDir] and retried once on the next launch.
class ReportSender {
  ReportSender({
    required this.endpoint,
    required this.apiKey,
    this.queueDir,
    http.Client? client,
    this.log = _noLog,
    Duration Function(int attempt)? retryDelay,
  })  : _client = client ?? http.Client(),
        _retryDelay = retryDelay ?? ((attempt) => Duration(seconds: math.pow(2, attempt).toInt()));

  static const maxRetries = 3;

  final String endpoint;
  final String apiKey;

  /// Where undeliverable reports wait for the next launch; null disables the queue (e.g. on web).
  final Future<Directory?> Function()? queueDir;
  final void Function(String message) log;
  final http.Client _client;
  final Duration Function(int attempt) _retryDelay;

  static void _noLog(String _) {}

  static String maskKey(String key) {
    if (key.isEmpty) return '(none)';
    return key.length <= 16 ? '${key.substring(0, math.min(8, key.length))}…' : '${key.substring(0, 12)}…${key.substring(key.length - 4)}';
  }

  Future<SendResult> send(ReportParts parts, {bool allowQueue = true}) async {
    final target = 'POST $endpoint (key ${maskKey(apiKey)})';
    var lastError = '';
    for (var attempt = 1; attempt <= maxRetries; attempt++) {
      final request = http.MultipartRequest('POST', Uri.parse(endpoint))
        ..headers['X-Api-Key'] = apiKey
        ..fields['report'] = parts.json;
      if (parts.logs != null && parts.logs!.isNotEmpty) {
        request.files.add(http.MultipartFile.fromBytes('logs', utf8.encode(parts.logs!), filename: 'logs.txt'));
      }
      if (parts.screenshot != null) request.files.add(http.MultipartFile.fromBytes('screenshot', parts.screenshot!, filename: 'screenshot.jpg'));
      if (parts.thumbnail != null) request.files.add(http.MultipartFile.fromBytes('thumbnail', parts.thumbnail!, filename: 'thumb.jpg'));
      if (parts.clip != null) request.files.add(http.MultipartFile.fromBytes('clip', parts.clip!, filename: 'clip.bin'));

      log('Sending report → $target — screenshot ${(parts.screenshot?.length ?? 0) ~/ 1024}KB, '
          'clip ${(parts.clip?.length ?? 0) ~/ 1024}KB, logs ${(parts.logs?.length ?? 0) ~/ 1024}KB (attempt $attempt/$maxRetries).');
      final clock = Stopwatch()..start();
      try {
        final response = await http.Response.fromStream(
          await _client.send(request).timeout(Duration(seconds: parts.clip != null ? 120 : 30)),
        );
        final body = _snippet(response.body);
        final ms = clock.elapsedMilliseconds;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          log('Report sent — HTTP ${response.statusCode} in ${ms}ms: $body');
          return SendResult(SendStatus.sent, httpStatus: response.statusCode, message: body);
        }
        if (response.statusCode == 413 && parts.clip != null) {
          log('Report too large (${(parts.clip!.length / 1048576).toStringAsFixed(1)}MB clip) — resending without the clip.');
          parts.clip = null;
          continue;
        }
        if (response.statusCode >= 400 && response.statusCode < 500) {
          log('Report rejected — HTTP ${response.statusCode} in ${ms}ms from $target: $body');
          return SendResult(SendStatus.rejected, httpStatus: response.statusCode, message: body);
        }
        lastError = 'HTTP ${response.statusCode}: $body';
      } on TimeoutException {
        lastError = 'no response in time';
      } catch (e) {
        lastError = e.toString(); // no network, DNS, TLS…
      }
      log('Send failed (attempt $attempt/$maxRetries) from $target: $lastError');
      if (attempt < maxRetries) await Future<void>.delayed(_retryDelay(attempt));
    }

    if (allowQueue && queueDir != null && await _queue(parts)) {
      return SendResult(SendStatus.queued, message: lastError);
    }
    return SendResult(SendStatus.failed, message: lastError);
  }

  Future<bool> _queue(ReportParts parts) async {
    try {
      final root = await queueDir!();
      if (root == null) return false;
      final dir = Directory('${root.path}/${DateTime.now().microsecondsSinceEpoch}-${math.Random().nextInt(1 << 32)}');
      await dir.create(recursive: true);
      if (parts.logs != null) await File('${dir.path}/logs.txt').writeAsString(parts.logs!);
      if (parts.screenshot != null) await File('${dir.path}/screenshot.jpg').writeAsBytes(parts.screenshot!);
      if (parts.thumbnail != null) await File('${dir.path}/thumb.jpg').writeAsBytes(parts.thumbnail!);
      if (parts.clip != null) await File('${dir.path}/clip.bin').writeAsBytes(parts.clip!);
      await File('${dir.path}/report.json').writeAsString(parts.json); // last: marks the folder complete
      log('Offline — report saved, it will be sent on the next launch.');
      return true;
    } catch (e) {
      log('Could not save the report for later: $e');
      return false;
    }
  }

  /// Send reports saved by an earlier session: one attempt each, then they are deleted either way.
  Future<void> flushQueue() async {
    final root = await queueDir?.call();
    if (root == null || !await root.exists()) return;
    final dirs = await root.list().where((e) => e is Directory).cast<Directory>().toList();
    if (dirs.isNotEmpty) log('Resending ${dirs.length} saved report(s) from an earlier session.');
    for (final dir in dirs) {
      final json = File('${dir.path}/report.json');
      if (await json.exists()) {
        Future<Uint8List?> bytes(String name) async {
          final f = File('${dir.path}/$name');
          return await f.exists() ? await f.readAsBytes() : null;
        }

        final logsFile = File('${dir.path}/logs.txt');
        await send(
          ReportParts(
            json: await json.readAsString(),
            logs: await logsFile.exists() ? await logsFile.readAsString() : null,
            screenshot: await bytes('screenshot.jpg'),
            thumbnail: await bytes('thumb.jpg'),
            clip: await bytes('clip.bin'),
          ),
          allowQueue: false,
        );
      }
      try {
        await dir.delete(recursive: true);
      } catch (_) {}
    }
  }

  static String _snippet(String text) {
    final t = text.replaceAll(RegExp(r'[\r\n]+'), ' ').trim();
    if (t.isEmpty) return '(empty)';
    return t.length > 300 ? '${t.substring(0, 300)}…' : t;
  }
}
