using System;
using System.Text;
using UnityEngine;

namespace BugReporter
{
    /// <summary>
    /// Fixed-size ring of the most recent log lines. Subscribes to Unity's log callback, which fires on
    /// whatever thread logged — so writes are locked. Allocation-light: the ring is a preallocated string[]
    /// and only the (rare) Dump() call builds a string.
    /// </summary>
    internal sealed class LogBuffer : IDisposable
    {
        private readonly string[] _lines;
        private readonly object _lock = new object();
        private readonly bool _includeWarnings;
        private int _next;      // next slot to write
        private bool _wrapped;  // has the ring wrapped at least once

        public LogBuffer(int capacity, bool includeWarnings = false)
        {
            _lines = new string[Mathf.Max(16, capacity)];
            _includeWarnings = includeWarnings;
            Application.logMessageReceivedThreaded += OnLog;
        }

        private void OnLog(string message, string stackTrace, LogType type)
        {
            // Warnings are the loudest, least useful thing in a bug report — a single frame can emit dozens and
            // shove the real error out of the ring. Drop them unless explicitly asked for. (Errors/asserts/
            // exceptions always stay.)
            if (type == LogType.Warning && !_includeWarnings) return;

            // Stack traces only for the log types where they carry information — otherwise a log
            // buffer of 200 lines becomes 200 pages of Unity internals.
            bool wantStack = type == LogType.Exception || type == LogType.Error || type == LogType.Assert;
            string line = wantStack && !string.IsNullOrEmpty(stackTrace)
                ? $"[{type}] {message}\n{stackTrace.TrimEnd()}"
                : $"[{type}] {message}";

            lock (_lock)
            {
                _lines[_next] = line;
                _next = (_next + 1) % _lines.Length;
                if (_next == 0) _wrapped = true;
            }
        }

        /// <summary>Oldest-to-newest, newline separated. Safe to call from the main thread while logging continues.</summary>
        public string Dump()
        {
            lock (_lock)
            {
                int count = _wrapped ? _lines.Length : _next;
                if (count == 0) return string.Empty;

                var sb = new StringBuilder(count * 80);
                int start = _wrapped ? _next : 0;
                for (int i = 0; i < count; i++)
                {
                    string line = _lines[(start + i) % _lines.Length];
                    if (line != null) sb.AppendLine(line);
                }
                return sb.ToString();
            }
        }

        public void Dispose()
        {
            Application.logMessageReceivedThreaded -= OnLog;
        }
    }
}
