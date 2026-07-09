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
        /// Master switch. Leave as <c>Debug.isDebugBuild</c> so the reporter can never reach a release build —
        /// the overlay button, the log hook and the network calls all hang off this.
        /// </summary>
        public bool Enabled = true;

        /// <summary>How many of the most recent log lines travel with a report.</summary>
        public int LogBufferSize = 200;

        /// <summary>Draw the floating report button. Off if you want to trigger reports from your own UI.</summary>
        public bool ShowReportButton = true;

        /// <summary>JPEG quality for the attached screenshot (1-100). 60 keeps a 1080p frame near 150 KB.</summary>
        public int ScreenshotQuality = 60;

        /// <summary>Reports that fail to send are written to disk and retried on the next launch.</summary>
        public bool QueueFailedReports = true;
    }
}
