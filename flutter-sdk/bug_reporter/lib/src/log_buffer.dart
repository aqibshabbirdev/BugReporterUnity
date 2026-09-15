/// Fixed-size ring of the most recent log lines, oldest dropped first.
class LogBuffer {
  LogBuffer(int capacity) : _lines = List<String?>.filled(capacity < 16 ? 16 : capacity, null);

  final List<String?> _lines;
  int _next = 0;
  bool _wrapped = false;

  void add(String level, String message) {
    final now = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    final stamp = '${two(now.hour)}:${two(now.minute)}:${two(now.second)}';
    _lines[_next] = '$stamp [$level] $message';
    _next = (_next + 1) % _lines.length;
    if (_next == 0) _wrapped = true;
  }

  /// Oldest to newest, one line per entry.
  String dump() {
    final count = _wrapped ? _lines.length : _next;
    if (count == 0) return '';
    final start = _wrapped ? _next : 0;
    final out = StringBuffer();
    for (var i = 0; i < count; i++) {
      final line = _lines[(start + i) % _lines.length];
      if (line != null) out.writeln(line);
    }
    return out.toString();
  }
}
