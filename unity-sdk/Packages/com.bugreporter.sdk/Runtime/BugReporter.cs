using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace BugReporter
{
    public enum Severity { Low, Normal, High, Crash }

    /// <summary>
    /// Entry point. Call <see cref="Init"/> once (a RuntimeInitializeOnLoadMethod is a good place), then either
    /// let the floating button drive reports or call <see cref="Report"/> yourself.
    ///
    /// <code>
    /// BugReporter.Init(new BugReporterConfig {
    ///     ApiKey   = "br_live_xxx",
    ///     Endpoint = "https://us-central1-myproj.cloudfunctions.net/report",
    ///     Enabled  = Debug.isDebugBuild,
    /// });
    /// BugReporter.SetMetadata("innings", 2);
    /// </code>
    /// </summary>
    public static class BugReporter
    {
        private static BugReporterConfig _config;
        private static LogBuffer _logs;
        private static ReportSender _sender;
        private static readonly Dictionary<string, object> _metadata = new Dictionary<string, object>();
        private static readonly object _gameLock = new object();
        private static string _game = string.Empty;

        public static bool IsActive => _config != null && _config.Enabled;
        internal static BugReporterConfig Config => _config;
        internal static string CurrentGame { get { lock (_gameLock) return _game; } }

        public static void Init(BugReporterConfig config)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (_config != null)
            {
                Debug.LogWarning("[BugReporter] Init called twice — ignoring the second call.");
                return;
            }
            if (!config.Enabled)
            {
                // Explicitly disabled (release build). Take no hooks, allocate nothing.
                _config = config;
                return;
            }
            // Pasted keys/URLs routinely arrive with stray whitespace or a newline — trim before validating,
            // or the server rejects every report with a confusing 401 (header present but malformed).
            config.ApiKey = config.ApiKey?.Trim();
            config.Endpoint = config.Endpoint?.Trim();
            if (string.IsNullOrEmpty(config.ApiKey) || string.IsNullOrEmpty(config.Endpoint))
            {
                Debug.LogError("[BugReporter] ApiKey and Endpoint are required — reporter stays off.");
                return;
            }
            if (!config.ApiKey.StartsWith("br_"))
            {
                Debug.LogError($"[BugReporter] ApiKey looks wrong ('{config.ApiKey.Substring(0, Math.Min(8, config.ApiKey.Length))}…') — it must start with br_. Get a fresh key from the dashboard (Settings → Rotate API key). Reporter stays off.");
                return;
            }

            if (string.IsNullOrEmpty(config.BuildVersion)) config.BuildVersion = Application.version;

            _config = config;
            lock (_gameLock) { _game = config.GameId?.Trim() ?? string.Empty; }
            _logs   = new LogBuffer(config.LogBufferSize, config.IncludeWarnings);
            _sender = ReportSender.Create();

            if (config.ShowReportButton) ReportOverlay.Create();

            Debug.Log($"[BugReporter] Ready — build {config.BuildVersion}, {config.LogBufferSize}-line log buffer.");
        }

        /// <summary>
        /// Attach live game state to whatever gets reported next. Overwrites the same key.
        /// Keep values small and JSON-friendly (string / number / bool).
        /// </summary>
        public static void SetMetadata(string key, object value)
        {
            if (!IsActive || string.IsNullOrEmpty(key)) return;
            lock (_metadata) { _metadata[key] = value; }
        }

        public static void ClearMetadata()
        {
            lock (_metadata) { _metadata.Clear(); }
        }

        /// <summary>
        /// Tag every subsequent report with the game the tester is currently in. Call this when a game scene
        /// loads (or the hub switches games); it sticks until the next call. One project/API key, many games —
        /// this is what lets the dashboard split them into separate lists instead of one mixed pile.
        /// </summary>
        public static void SetGame(string gameId)
        {
            lock (_gameLock) { _game = gameId?.Trim() ?? string.Empty; }
        }

        /// <summary>
        /// File a report. Captures a screenshot and the current log buffer, then uploads (with retry, and a
        /// disk queue if offline). Returns immediately — the work runs on a coroutine.
        /// </summary>
        public static void Report(string title, string description = null, Severity severity = Severity.Normal)
        {
            if (!IsActive || _sender == null) return;
            if (string.IsNullOrWhiteSpace(title)) title = "(no title)";

            Dictionary<string, object> meta;
            lock (_metadata) { meta = new Dictionary<string, object>(_metadata); }

            // The active scene's asset path (e.g. "Assets/_Games/CRICKET/Scene/Ground.unity") is preserved in
            // builds — the backend derives the game from the "_Games/<Game>/" segment, so no per-game wiring is
            // needed. GetActiveScene is main-thread only; Report runs on the main thread. `game` (from SetGame)
            // stays an optional override the server prefers when set.
            var active = SceneManager.GetActiveScene();
            string scenePath = string.IsNullOrEmpty(active.path) ? active.name : active.path;

            _sender.Submit(new ReportPayload
            {
                title        = title,
                description  = description ?? string.Empty,
                severity     = severity.ToString().ToLowerInvariant(),
                buildVersion = _config.BuildVersion,
                game         = CurrentGame,
                scene        = scenePath,
                logs         = _logs != null ? _logs.Dump() : string.Empty,
                metadata     = meta,
                device       = DeviceInfo.Capture(),
            });
        }

        /// <summary>Internal: the overlay asks for this when the user submits.</summary>
        internal static void ReportFromOverlay(string title, Severity severity) => Report(title, null, severity);
    }
}
