import 'dart:convert';

import 'package:bug_reporter/bug_reporter.dart';
import 'package:bug_reporter/src/sender.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  tearDown(BugReporter.debugReset);

  Widget app() => MaterialApp(
        builder: (context, child) => BugReporterOverlay(child: child!),
        navigatorObservers: [BugReporter.navigatorObserver],
        initialRoute: '/home',
        routes: {'/home': (_) => const Scaffold(body: Center(child: Text('Game screen')))},
      );

  testWidgets('inactive: no button, app still renders', (tester) async {
    await tester.pumpWidget(app());
    expect(find.text('Game screen'), findsOneWidget);
    expect(find.text('🐞 Report'), findsNothing);
  });

  testWidgets('button → note → category sends a report with title, note and severity', (tester) async {
    Map<String, dynamic>? sent;
    final client = MockClient((req) async {
      final body = latin1.decode(req.bodyBytes);
      final start = body.indexOf('{"title"');
      sent = jsonDecode(utf8.decode(latin1.encode(body.substring(start, body.indexOf('\r\n', start))))) as Map<String, dynamic>;
      return http.Response('{"id":"x"}', 201);
    });
    const config = BugReporterConfig(apiKey: 'br_live_test', endpoint: 'https://example.test/api/report');
    BugReporter.debugActivate(config, ReportSender(endpoint: config.endpoint, apiKey: config.apiKey, client: client));
    BugReporter.setGame('Ludo');
    BugReporter.setMetadata('level', 7);

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(BugReporter.debugRoute, '/home');

    await tester.tap(find.text('🐞 Report'));
    await tester.pumpAndSettle();
    expect(find.text('Report a bug'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'dice stuck after 6');
    await tester.runAsync(() async {
      await tester.tap(find.text('🧊 Freeze / Stuck'));
      await tester.pump();
      for (var i = 0; i < 50 && sent == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        await tester.pump();
      }
    });
    await tester.pump();

    expect(sent, isNotNull);
    expect(sent!['title'], '🧊 Freeze / Stuck');
    expect(sent!['description'], 'dice stuck after 6');
    expect(sent!['severity'], 'high');
    expect(sent!['game'], 'Ludo');
    expect(sent!['scene'], '/home');
    expect(sent!['metadata'], {'level': 7});
    expect(find.text('Report a bug'), findsNothing);
    expect(find.text('Game screen'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
  });
}
