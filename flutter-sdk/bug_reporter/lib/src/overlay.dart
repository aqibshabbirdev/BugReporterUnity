import 'dart:async';

import 'package:flutter/material.dart';

import 'bug_reporter.dart';
import 'capture.dart';

/// Put this in `MaterialApp.builder`: `builder: (context, child) => BugReporterOverlay(child: child!)`.
/// It wraps the app in the boundary screenshots are taken from and, while the reporter is active, draws a
/// draggable 🐞 Report button with a one-tap category form above it (outside the screenshot).
class BugReporterOverlay extends StatelessWidget {
  const BugReporterOverlay({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    // The app stays at the same place in the tree whatever the reporter does, so its state is never lost.
    return Stack(
      textDirection: TextDirection.ltr,
      children: [
        Positioned.fill(child: RepaintBoundary(key: ScreenCapture.boundaryKey, child: child)),
        Positioned.fill(
          child: ValueListenableBuilder<bool>(
            valueListenable: BugReporter.active,
            builder: (context, on, _) =>
                on && (BugReporter.config?.showReportButton ?? false) ? Overlay.wrap(child: const _ReporterLayer()) : const SizedBox.shrink(),
          ),
        ),
      ],
    );
  }
}

class _ReporterLayer extends StatefulWidget {
  const _ReporterLayer();

  @override
  State<_ReporterLayer> createState() => _ReporterLayerState();
}

class _ReporterLayerState extends State<_ReporterLayer> {
  // One tap files the report — mid-game there's no time to type. Same categories as the Unity SDK.
  static const _tags = <(String, Severity)>[
    ('💥 Crash', Severity.crash),
    ('🧊 Freeze / Stuck', Severity.high),
    ('❌ Wrong result', Severity.high),
    ('🎨 Visual bug', Severity.normal),
    ('📶 Lag / Network', Severity.normal),
    ('❓ Other', Severity.normal),
  ];

  final _note = TextEditingController();
  Offset? _pos;
  bool _formOpen = false;
  bool _sending = false;
  String? _toast;
  bool _toastError = false;
  Timer? _toastTimer;

  @override
  void dispose() {
    _note.dispose();
    _toastTimer?.cancel();
    super.dispose();
  }

  Future<void> _send(String title, Severity severity) async {
    final note = _note.text.trim();
    // Close the form first and let a frame paint without it.
    setState(() {
      _formOpen = false;
      _sending = true;
      _toast = 'Sending bug report…';
      _toastError = false;
    });
    await WidgetsBinding.instance.endOfFrame;
    final result = await BugReporter.report(title, description: note, severity: severity);
    if (!mounted) return;
    _note.clear();
    final (text, isError) = switch (result.outcome) {
      ReportOutcome.sent => ('✓ Bug report sent', false),
      ReportOutcome.queued => ('Saved — it will be sent when you are back online', false),
      ReportOutcome.rejected => ('✕ Report rejected: ${result.message}', true),
      ReportOutcome.failed => ('✕ Could not send the report', true),
      ReportOutcome.inactive => ('Bug reporter is off', true),
    };
    setState(() {
      _sending = false;
      _toast = text;
      _toastError = isError;
    });
    _toastTimer?.cancel();
    _toastTimer = Timer(Duration(seconds: isError ? 5 : 3), () {
      if (mounted) setState(() => _toast = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.sizeOf(context);
    final pos = _pos ?? Offset(12, media.height * 0.18);
    final theme = Theme.of(context);

    return Stack(
      children: [
        if (!_formOpen && !_sending)
          Positioned(
            left: pos.dx.clamp(0, media.width - 110),
            top: pos.dy.clamp(0, media.height - 48),
            child: GestureDetector(
              onPanUpdate: (d) => setState(() => _pos = pos + d.delta),
              child: Material(
                color: Colors.black.withValues(alpha: 0.72),
                shape: const StadiumBorder(),
                elevation: 4,
                child: InkWell(
                  customBorder: const StadiumBorder(),
                  onTap: () => setState(() => _formOpen = true),
                  child: const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    child: Text('🐞 Report', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
                  ),
                ),
              ),
            ),
          ),
        if (_formOpen)
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque, // the scrim swallows taps so the game underneath doesn't get them
              onTap: () => FocusScope.of(context).unfocus(),
              child: ColoredBox(
                color: Colors.black54,
                child: SafeArea(
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 460),
                      child: Material(
                        borderRadius: BorderRadius.circular(16),
                        color: theme.colorScheme.surface,
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.all(18),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text('Report a bug', style: theme.textTheme.titleMedium),
                              const SizedBox(height: 12),
                              TextField(
                                controller: _note,
                                maxLength: 300,
                                minLines: 2,
                                maxLines: 4,
                                decoration: const InputDecoration(
                                  labelText: 'Note (optional)',
                                  hintText: 'What happened, in your words',
                                  border: OutlineInputBorder(),
                                ),
                              ),
                              const SizedBox(height: 6),
                              Text('Tap a category to send:', style: theme.textTheme.bodySmall),
                              const SizedBox(height: 8),
                              Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: [
                                  for (final (label, severity) in _tags)
                                    FilledButton.tonal(onPressed: () => _send(label, severity), child: Text(label)),
                                ],
                              ),
                              const SizedBox(height: 10),
                              TextButton(
                                onPressed: () => setState(() {
                                  _formOpen = false;
                                  _note.clear();
                                }),
                                child: const Text('Cancel'),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        if (_toast != null)
          Positioned(
            left: 16,
            right: 16,
            top: media.height * 0.06,
            child: IgnorePointer(
              child: Center(
                child: Material(
                  color: _toastError ? Colors.red.shade700 : Colors.black87,
                  borderRadius: BorderRadius.circular(10),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    child: Text(_toast!, style: const TextStyle(color: Colors.white)),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
