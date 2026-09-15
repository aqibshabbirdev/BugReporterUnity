import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:bug_reporter/src/clip_recorder.dart';
import 'package:bug_reporter/src/log_buffer.dart';
import 'package:bug_reporter/src/payload.dart';
import 'package:bug_reporter/src/sender.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('LogBuffer', () {
    test('keeps the newest lines, oldest first', () {
      final b = LogBuffer(16);
      for (var i = 0; i < 20; i++) {
        b.add('Log', 'line $i');
      }
      final lines = b.dump().trim().split('\n');
      expect(lines, hasLength(16));
      expect(lines.first, endsWith('[Log] line 4'));
      expect(lines.last, endsWith('[Log] line 19'));
    });
  });

  test('payload JSON has the fields the server reads', () {
    final json = jsonDecode(ReportPayload(
      title: 'Crash', description: 'note', severity: 'crash', buildVersion: '1.2+3', game: 'Ludo', session: 'tx1',
      scene: '/game', device: const DeviceSnapshot(platform: 'Android', deviceModel: 'Pixel', osVersion: 'Android 15', screenResolution: '1080x2400', memoryMB: 8000),
      metadata: {'level': 3, 'ok': true, 'obj': Duration.zero}, clipFps: 4,
    ).toJson()) as Map<String, dynamic>;
    expect(json.keys, containsAll(['title', 'description', 'severity', 'buildVersion', 'game', 'session', 'scene', 'platform', 'deviceModel', 'osVersion', 'screenResolution', 'memoryMB', 'clipFps', 'metadata']));
    expect(json['metadata'], {'level': 3, 'ok': true, 'obj': '0:00:00.000000'});
  });

  group('ClipRecorder.packLatest', () {
    Uint8List frame(int n, int size) => Uint8List.fromList([0xff, 0xd8, 0xff, ...List.filled(size - 3, n)]);

    test('packs little-endian count, lengths, then frames', () {
      final r = ClipRecorder(seconds: 1, fps: 3, maxWidth: 100, quality: 50, maxBytes: 1 << 20);
      r.push(frame(1, 10));
      r.push(frame(2, 20));
      final blob = r.packLatest()!;
      final bd = ByteData.sublistView(blob);
      expect(bd.getUint32(0, Endian.little), 2);
      expect(bd.getUint32(4, Endian.little), 10);
      expect(bd.getUint32(8, Endian.little), 20);
      expect(blob.length, 12 + 30);
      expect(blob[12 + 3], 1);
      expect(blob[12 + 10 + 3], 2);
    });

    test('ring keeps the newest frames and trims the oldest to the byte budget', () {
      final r = ClipRecorder(seconds: 1, fps: 4, maxWidth: 100, quality: 50, maxBytes: 0); // budget floor 256KB
      for (var i = 0; i < 6; i++) {
        r.push(frame(i, 100 * 1024));
      }
      final bd = ByteData.sublistView(r.packLatest()!);
      expect(bd.getUint32(0, Endian.little), 2); // 4 in the ring, only the 2 newest fit 256KB
      expect(r.packLatest()![4 + 8 + 3], 4);
    });
  });

  group('ReportSender', () {
    late Directory tmp;
    setUp(() async => tmp = await Directory.systemTemp.createTemp('br_test'));
    tearDown(() async => tmp.delete(recursive: true));

    ReportParts parts({bool clip = false}) => ReportParts(
          json: '{"title":"t"}', logs: 'hello', screenshot: Uint8List.fromList([0xff, 0xd8, 0xff, 1]),
          thumbnail: Uint8List.fromList([0xff, 0xd8, 0xff, 2]), clip: clip ? Uint8List(10) : null,
        );

    test('sends multipart with the key and all parts', () async {
      late http.BaseRequest seen;
      final client = MockClient.streaming((request, body) async {
        seen = request;
        final text = latin1.decode(await body.toBytes());
        expect(text, contains('name="report"'));
        expect(text, contains('{"title":"t"}'));
        expect(text, contains('name="logs"; filename="logs.txt"'));
        expect(text, contains('name="screenshot"; filename="screenshot.jpg"'));
        expect(text, contains('name="thumbnail"; filename="thumb.jpg"'));
        return http.StreamedResponse(Stream.value(utf8.encode('{"id":"x"}')), 201);
      });
      final s = ReportSender(endpoint: 'https://example.test/api/report', apiKey: 'br_live_abc', client: client);
      final r = await s.send(parts());
      expect(r.status, SendStatus.sent);
      expect(seen.headers['X-Api-Key'], 'br_live_abc');
    });

    test('a 4xx is final: no retry, nothing queued', () async {
      var calls = 0;
      final client = MockClient((_) async { calls++; return http.Response('{"error":"unknown api key"}', 401); });
      final s = ReportSender(endpoint: 'https://example.test/r', apiKey: 'br_x', client: client, queueDir: () async => tmp, retryDelay: (_) => Duration.zero);
      final r = await s.send(parts());
      expect(r.status, SendStatus.rejected);
      expect(r.httpStatus, 401);
      expect(calls, 1);
      expect(tmp.listSync(), isEmpty);
    });

    test('413 retries once without the clip', () async {
      final bodies = <int>[];
      final client = MockClient((req) async {
        bodies.add(req.bodyBytes.length);
        return bodies.length == 1 ? http.Response('too big', 413) : http.Response('{"id":"x"}', 201);
      });
      final s = ReportSender(endpoint: 'https://example.test/r', apiKey: 'br_x', client: client, retryDelay: (_) => Duration.zero);
      final p = parts(clip: true);
      final r = await s.send(p);
      expect(r.status, SendStatus.sent);
      expect(bodies, hasLength(2));
      expect(p.clip, isNull);
    });

    test('server errors retry three times, then queue; the next launch sends and clears the queue', () async {
      var calls = 0;
      var down = true;
      final client = MockClient((req) async {
        calls++;
        return down ? http.Response('oops', 503) : http.Response('{"id":"x"}', 201);
      });
      final s = ReportSender(endpoint: 'https://example.test/r', apiKey: 'br_x', client: client, queueDir: () async => tmp, retryDelay: (_) => Duration.zero);
      final r = await s.send(parts());
      expect(r.status, SendStatus.queued);
      expect(calls, 3);
      final queued = tmp.listSync().single as Directory;
      expect(File('${queued.path}/report.json').existsSync(), isTrue);
      expect(File('${queued.path}/screenshot.jpg').existsSync(), isTrue);

      down = false;
      await s.flushQueue();
      expect(calls, 4);
      expect(tmp.listSync(), isEmpty);
    });

    test('network exceptions count as failures', () async {
      final client = MockClient((_) async => throw const SocketException('no network'));
      final s = ReportSender(endpoint: 'https://example.test/r', apiKey: 'br_x', client: client, retryDelay: (_) => Duration.zero);
      expect((await s.send(parts())).status, SendStatus.failed);
    });
  });

  test('maskKey', () {
    expect(ReportSender.maskKey('br_live_0123456789abcdef0123456789abcdef'), 'br_live_0123…cdef');
  });
}
