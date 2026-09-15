import 'package:bug_reporter/bug_reporter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

// flutter run --dart-define=BUG_REPORTER_KEY=br_live_... --dart-define=TESTER_BUILD=true
const _apiKey = String.fromEnvironment('BUG_REPORTER_KEY');
const _testerBuild = bool.fromEnvironment('TESTER_BUILD');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BugReporter.init(const BugReporterConfig(
    apiKey: _apiKey,
    endpoint: 'https://pandabugsreporting.com/api/report',
    enabled: !kReleaseMode || _testerBuild,
  ));
  BugReporter.runGuarded(() => runApp(const ExampleApp()));
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bug Reporter example',
      builder: (context, child) => BugReporterOverlay(child: child!),
      navigatorObservers: [BugReporter.navigatorObserver],
      initialRoute: '/',
      routes: {
        '/': (_) => const HomePage(),
        '/game': (_) => const GamePage(),
      },
    );
  }
}

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Home')),
        body: Center(
          child: FilledButton(
            onPressed: () {
              BugReporter.setGame('Ludo');
              Navigator.pushNamed(context, '/game');
            },
            child: const Text('Play Ludo'),
          ),
        ),
      );
}

class GamePage extends StatefulWidget {
  const GamePage({super.key});

  @override
  State<GamePage> createState() => _GamePageState();
}

class _GamePageState extends State<GamePage> {
  int _dice = 1;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Ludo')),
        body: Center(child: Text('Dice: $_dice', style: const TextStyle(fontSize: 48))),
        floatingActionButton: FloatingActionButton(
          onPressed: () {
            setState(() => _dice = _dice % 6 + 1);
            BugReporter.setMetadata('dice', _dice);
            debugPrint('rolled $_dice');
          },
          child: const Icon(Icons.casino),
        ),
      );
}
