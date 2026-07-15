using System;

namespace BugReporter
{
    /// <summary>
    /// Settings handed to <see cref="BugReporter.Init"/>. Everything has a sane default except
    /// <see cref="ApiKey"/> and <see cref="Endpoint"/>, which identify your project's ingest function.
    /// </summary>
    [Serializable]
    public class BugReporterConfig
    {
        /// <summary>Per-project write-only key. Safe to embed in a dev build; revocable from the dashboard.</summary>
        public string ApiKey;

        /// <summary>HTTPS ingest endpoint, e.g. https://us-central1-&lt;project&gt;.cloudfunctions.net/report</summary>
        public string Endpoint;

        /// <summary>Shown on every issue so you know which build the tester was on. Defaults to Application.version.</summary>
        public string BuildVersion;

        /// <summary>
        /// Which game this report belongs to. One project (one API key) can host many games — set this so the
        /// dashboard can group/filter issues per game instead of one mixed pile. Value here is the starting
        /// game; call <see cref="BugReporter.SetGame"/> at runtime whenever the active game changes.
        /// </summary>
        public string GameId;

        /// <summary>
        /// Master switch. Leave as <c>Debug.isDebugBuild</c> so the reporter can never reach a release build —
        /// the overlay button, the log hook and the network calls all hang off this.
        /// </summary>
        public bool Enabled = true;

        /// <summary>How many of the most recent log lines travel with a report.</summary>
        public int LogBufferSize = 200;

        /// <summary>
        /// Capture <c>Debug.LogWarning</c> lines in the log buffer. Off by default: warnings routinely flood the
        /// buffer with 100+ lines of noise and push the actual error out of the ring. Errors, asserts and
        /// exceptions are always captured regardless.
        /// </summary>
        public bool IncludeWarnings = false;

        /// <summary>Draw the floating report button. Off if you want to trigger reports from your own UI.</summary>
        public bool ShowReportButton = true;

        /// <summary>JPEG quality for the attached screenshot (1-100). 60 keeps a 1080p frame near 150 KB.</summary>
        public int ScreenshotQuality = 60;

        /// <summary>Reports that fail to send are written to disk and retried on the next launch.</summary>
        public bool QueueFailedReports = true;

        // ── Clip recording (the last few seconds of gameplay as a low-fps "flipbook") ────────────────────
        // OFF by default: it captures the screen continuously, which is a real (if small) perf/battery cost —
        // keep it to tester builds. Requires async GPU readback (most modern devices); silently no-ops without.

        /// <summary>Record a rolling clip of the last <see cref="ClipSeconds"/> and attach it to reports.</summary>
        public bool RecordClip = false;

        /// <summary>How many seconds of gameplay the rolling clip keeps.</summary>
        public int ClipSeconds = 20;

        /// <summary>Frames captured per second (1–15). Lower = cheaper + smaller. 6 is a good default.</summary>
        public int ClipFps = 6;

        /// <summary>Longest side of a clip frame in pixels — frames are downscaled to keep the upload small.</summary>
        public int ClipMaxWidth = 360;

        /// <summary>JPEG quality for clip frames (1–100). These are previews, so ~45 is plenty.</summary>
        public int ClipQuality = 45;

        /// <summary>Flip clip frames vertically. Screen capture orientation is graphics-API dependent; if the
        /// clip comes out upside-down on a device, flip this.</summary>
        public bool ClipFlipY = false;
    }
}
