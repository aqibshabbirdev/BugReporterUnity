using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace BugReporter
{
    /// <summary>
    /// Owns the upload: screenshot capture, multipart POST, retry with backoff, and a disk queue so a report
    /// filed offline (or during a crash-adjacent moment) survives to the next launch.
    /// </summary>
    internal sealed class ReportSender : MonoBehaviour
    {
        private const int MaxRetries = 3;
        private static string QueueDir => Path.Combine(Application.persistentDataPath, "bugreporter-queue");

        public static ReportSender Create()
        {
            var go = new GameObject("[BugReporter]");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideInHierarchy;
            var sender = go.AddComponent<ReportSender>();
            sender.StartCoroutine(sender.FlushQueue());
            return sender;
        }

        public void Submit(ReportPayload payload) => StartCoroutine(CaptureAndSend(payload));

        private IEnumerator CaptureAndSend(ReportPayload payload)
        {
            // The screenshot must be taken after the frame has finished rendering, or we capture a half-drawn
            // frame (or throw on some platforms).
            yield return new WaitForEndOfFrame();

            byte[] screenshot = null;
            try
            {
                var tex = ScreenCapture.CaptureScreenshotAsTexture();
                screenshot = tex.EncodeToJPG(Mathf.Clamp(BugReporter.Config.ScreenshotQuality, 1, 100));
                Destroy(tex);
            }
            catch (Exception e)
            {
                // A missing screenshot must never lose the report — the logs are the valuable half.
                Debug.LogWarning($"[BugReporter] Screenshot capture failed ({e.Message}) — sending report without it.");
            }

            yield return Send(payload.ToJson(), payload.logs, screenshot, allowQueue: true);
        }

        private IEnumerator Send(string json, string logs, byte[] screenshot, bool allowQueue)
        {
            for (int attempt = 1; attempt <= MaxRetries; attempt++)
            {
                var form = new List<IMultipartFormSection>
                {
                    new MultipartFormDataSection("report", json, Encoding.UTF8, "application/json"),
                };
                if (!string.IsNullOrEmpty(logs))
                    form.Add(new MultipartFormFileSection("logs", Encoding.UTF8.GetBytes(logs), "logs.txt", "text/plain"));
                if (screenshot != null && screenshot.Length > 0)
                    form.Add(new MultipartFormFileSection("screenshot", screenshot, "screenshot.jpg", "image/jpeg"));

                using (var req = UnityWebRequest.Post(BugReporter.Config.Endpoint, form))
                {
                    req.SetRequestHeader("X-Api-Key", BugReporter.Config.ApiKey);
                    req.timeout = 30;
                    yield return req.SendWebRequest();

                    if (req.result == UnityWebRequest.Result.Success)
                    {
                        Debug.Log("[BugReporter] Report sent.");
                        yield break;
                    }

                    // A 4xx means the server rejected the report itself (bad key, malformed body). Retrying or
                    // queueing it would just repeat the rejection — drop it and say why.
                    bool clientError = req.responseCode >= 400 && req.responseCode < 500;
                    if (clientError)
                    {
                        Debug.LogError($"[BugReporter] Report rejected ({req.responseCode}): {req.downloadHandler?.text}");
                        yield break;
                    }

                    Debug.LogWarning($"[BugReporter] Send failed (attempt {attempt}/{MaxRetries}): {req.error}");
                }

                if (attempt < MaxRetries)
                    yield return new WaitForSecondsRealtime(Mathf.Pow(2f, attempt)); // 2s, 4s
            }

            if (allowQueue && BugReporter.Config.QueueFailedReports)
                QueueToDisk(json, logs, screenshot);
        }

        // ── Offline queue ────────────────────────────────────────────────────────────────────────────
        // One folder per report so a partial write can be detected (report.json is written last, and is what
        // FlushQueue keys off).

        private void QueueToDisk(string json, string logs, byte[] screenshot)
        {
            try
            {
                string dir = Path.Combine(QueueDir, Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                if (!string.IsNullOrEmpty(logs)) File.WriteAllText(Path.Combine(dir, "logs.txt"), logs);
                if (screenshot != null) File.WriteAllBytes(Path.Combine(dir, "screenshot.jpg"), screenshot);
                File.WriteAllText(Path.Combine(dir, "report.json"), json);   // last — the completion marker
                Debug.Log("[BugReporter] Offline — report queued, will retry on next launch.");
            }
            catch (Exception e)
            {
                Debug.LogError($"[BugReporter] Could not queue report: {e.Message}");
            }
        }

        private IEnumerator FlushQueue()
        {
            if (!Directory.Exists(QueueDir)) yield break;

            foreach (string dir in Directory.GetDirectories(QueueDir))
            {
                string jsonPath = Path.Combine(dir, "report.json");
                if (!File.Exists(jsonPath)) { TryDelete(dir); continue; }   // partial write — nothing to send

                string json = File.ReadAllText(jsonPath);
                string logsPath = Path.Combine(dir, "logs.txt");
                string shotPath = Path.Combine(dir, "screenshot.jpg");
                string logs = File.Exists(logsPath) ? File.ReadAllText(logsPath) : null;
                byte[] shot = File.Exists(shotPath) ? File.ReadAllBytes(shotPath) : null;

                // allowQueue:false — a queued report that fails again must not re-queue itself forever.
                yield return Send(json, logs, shot, allowQueue: false);
                TryDelete(dir);
            }
        }

        private static void TryDelete(string dir)
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* next launch will retry the delete */ }
        }
    }
}
