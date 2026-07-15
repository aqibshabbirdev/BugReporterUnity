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

            byte[] screenshot = null, thumbnail = null;
            try
            {
                var tex = ScreenCapture.CaptureScreenshotAsTexture();
                try
                {
                    screenshot = tex.EncodeToJPG(Mathf.Clamp(BugReporter.Config.ScreenshotQuality, 1, 100));
                    // A small thumbnail travels with the report so the dashboard grid can show previews without
                    // downloading every full screenshot (which was making the grid crawl). Full shot stays for detail.
                    try { thumbnail = MakeThumbnailJpg(tex, 400, 55); }
                    catch (Exception te) { Debug.LogWarning($"[BugReporter] Thumbnail failed ({te.Message}) — sending full shot only."); }
                }
                finally { Destroy(tex); }
            }
            catch (Exception e)
            {
                // A missing screenshot must never lose the report — the logs are the valuable half.
                Debug.LogWarning($"[BugReporter] Screenshot capture failed ({e.Message}) — sending report without it.");
            }

            yield return Send(payload.ToJson(), payload.logs, screenshot, thumbnail, payload.clip, allowQueue: true);
        }

        /// <summary>Downscale a screenshot to a small JPEG (longest side ≤ maxDim) via a GPU blit — cheap, and the
        /// grid loads these instead of full frames.</summary>
        private static byte[] MakeThumbnailJpg(Texture2D src, int maxDim, int quality)
        {
            float scale = Mathf.Min(1f, (float)maxDim / Mathf.Max(src.width, src.height));
            int tw = Mathf.Max(1, Mathf.RoundToInt(src.width * scale));
            int th = Mathf.Max(1, Mathf.RoundToInt(src.height * scale));

            var rt = RenderTexture.GetTemporary(tw, th, 0, RenderTextureFormat.ARGB32);
            var prev = RenderTexture.active;
            Texture2D small = null;
            try
            {
                Graphics.Blit(src, rt);
                RenderTexture.active = rt;
                small = new Texture2D(tw, th, TextureFormat.RGB24, false);
                small.ReadPixels(new Rect(0, 0, tw, th), 0, 0);
                small.Apply();
                return small.EncodeToJPG(quality);
            }
            finally
            {
                RenderTexture.active = prev;
                RenderTexture.ReleaseTemporary(rt);
                if (small != null) Destroy(small);
            }
        }

        private IEnumerator Send(string json, string logs, byte[] screenshot, byte[] thumbnail, byte[] clip, bool allowQueue)
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
                if (thumbnail != null && thumbnail.Length > 0)
                    form.Add(new MultipartFormFileSection("thumbnail", thumbnail, "thumb.jpg", "image/jpeg"));
                if (clip != null && clip.Length > 0)
                    form.Add(new MultipartFormFileSection("clip", clip, "clip.bin", "application/octet-stream"));

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
                QueueToDisk(json, logs, screenshot, thumbnail, clip);
        }

        // ── Offline queue ────────────────────────────────────────────────────────────────────────────
        // One folder per report so a partial write can be detected (report.json is written last, and is what
        // FlushQueue keys off).

        private void QueueToDisk(string json, string logs, byte[] screenshot, byte[] thumbnail, byte[] clip)
        {
            try
            {
                string dir = Path.Combine(QueueDir, Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                if (!string.IsNullOrEmpty(logs)) File.WriteAllText(Path.Combine(dir, "logs.txt"), logs);
                if (screenshot != null) File.WriteAllBytes(Path.Combine(dir, "screenshot.jpg"), screenshot);
                if (thumbnail != null) File.WriteAllBytes(Path.Combine(dir, "thumb.jpg"), thumbnail);
                if (clip != null) File.WriteAllBytes(Path.Combine(dir, "clip.bin"), clip);
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
                string thumbPath = Path.Combine(dir, "thumb.jpg");
                string clipPath = Path.Combine(dir, "clip.bin");
                string logs = File.Exists(logsPath) ? File.ReadAllText(logsPath) : null;
                byte[] shot = File.Exists(shotPath) ? File.ReadAllBytes(shotPath) : null;
                byte[] thumb = File.Exists(thumbPath) ? File.ReadAllBytes(thumbPath) : null;
                byte[] clip = File.Exists(clipPath) ? File.ReadAllBytes(clipPath) : null;

                // allowQueue:false — a queued report that fails again must not re-queue itself forever.
                yield return Send(json, logs, shot, thumb, clip, allowQueue: false);
                TryDelete(dir);
            }
        }

        private static void TryDelete(string dir)
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* next launch will retry the delete */ }
        }
    }
}
