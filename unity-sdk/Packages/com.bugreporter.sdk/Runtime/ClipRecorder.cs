using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;

namespace BugReporter
{
    /// <summary>
    /// Keeps a rolling buffer of the last N seconds of the screen as small JPEG frames (a "flipbook"), so a
    /// report can carry a short clip of what led to the bug. Capture is throttled to a low fps and uses an
    /// async GPU readback so it doesn't stall the render thread. Opt-in (<see cref="BugReporterConfig.RecordClip"/>) —
    /// it's a continuous cost, so keep it to tester builds.
    /// </summary>
    internal sealed class ClipRecorder : MonoBehaviour
    {
        private byte[][] _ring;
        private int _next;
        private bool _wrapped;
        private readonly object _lock = new object();
        private int _maxW, _quality, _inFlight;
        private float _interval, _lastCapture;
        private bool _flipY;

        /// <summary>The fps actually used (after clamping) — travels with the report so the dashboard plays
        /// the clip at real speed instead of guessing.</summary>
        public int Fps { get; private set; }

        public static ClipRecorder Create()
        {
            var cfg = BugReporter.Config;
            var go = new GameObject("[BugReporter.Clip]");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideInHierarchy;
            var r = go.AddComponent<ClipRecorder>();

            int fps = Mathf.Clamp(cfg.ClipFps, 1, 15);
            int frames = Mathf.Clamp(Mathf.Max(1, cfg.ClipSeconds) * fps, fps, 900);
            r._ring = new byte[frames][];
            r._interval = 1f / fps;
            r.Fps = fps;
            r._quality = Mathf.Clamp(cfg.ClipQuality, 1, 100);
            r._maxW = Mathf.Clamp(cfg.ClipMaxWidth, 120, 1280);
            r._flipY = cfg.ClipFlipY;

            if (SystemInfo.supportsAsyncGPUReadback)
            {
                r.StartCoroutine(r.CaptureLoop());
                Debug.Log($"[BugReporter] Clip recording on — last {cfg.ClipSeconds}s at {fps}fps ({frames} frames).");
                if (frames > 300)
                {
                    Debug.LogWarning($"[BugReporter] {frames} frames is a big ring — only the newest " +
                        $"~{Mathf.Max(256 * 1024, cfg.ClipMaxBytes) / 1048576}MB is ever uploaded (the rest just holds RAM, " +
                        $"roughly {frames * 35 / 1024}MB of it). A shorter ClipSeconds gets you the same clip for less.");
                }
            }
            else
            {
                Debug.LogWarning("[BugReporter] Async GPU readback unsupported — clip recording disabled on this device.");
            }
            return r;
        }

        private IEnumerator CaptureLoop()
        {
            var wait = new WaitForEndOfFrame();
            while (true)
            {
                yield return wait;
                if (Time.unscaledTime - _lastCapture < _interval) continue;
                if (_inFlight > 1) continue;          // don't let readbacks pile up under load
                _lastCapture = Time.unscaledTime;
                try { CaptureOne(); }
                catch (Exception e) { Debug.LogWarning($"[BugReporter] Clip capture skipped: {e.Message}"); }
            }
        }

        private void CaptureOne()
        {
            int sw = Screen.width, sh = Screen.height;
            if (sw <= 0 || sh <= 0) return;

            float scale = Mathf.Min(1f, (float)_maxW / sw);
            int tw = Mathf.Max(1, Mathf.RoundToInt(sw * scale));
            int th = Mathf.Max(1, Mathf.RoundToInt(sh * scale));

            var full = RenderTexture.GetTemporary(sw, sh, 0, RenderTextureFormat.ARGB32);
            ScreenCapture.CaptureScreenshotIntoRenderTexture(full);
            var small = RenderTexture.GetTemporary(tw, th, 0, RenderTextureFormat.ARGB32);
            if (_flipY) Graphics.Blit(full, small, new Vector2(1, -1), new Vector2(0, 1));
            else Graphics.Blit(full, small);
            RenderTexture.ReleaseTemporary(full);

            _inFlight++;
            AsyncGPUReadback.Request(small, 0, TextureFormat.RGBA32, req =>
            {
                _inFlight = Mathf.Max(0, _inFlight - 1);
                try
                {
                    if (!req.hasError)
                    {
                        var data = req.GetData<byte>();
                        var jpg = ImageConversion.EncodeNativeArrayToJPG(
                            data, GraphicsFormat.R8G8B8A8_UNorm, (uint)tw, (uint)th, 0, _quality);
                        byte[] bytes = jpg.ToArray();
                        jpg.Dispose();
                        Push(bytes);
                    }
                }
                catch (Exception e) { Debug.LogWarning($"[BugReporter] Clip frame encode failed: {e.Message}"); }
                finally { RenderTexture.ReleaseTemporary(small); }
            });
        }

        private void Push(byte[] frame)
        {
            lock (_lock)
            {
                _ring[_next] = frame;
                _next = (_next + 1) % _ring.Length;
                if (_next == 0) _wrapped = true;
            }
        }

        /// <summary>
        /// Snapshot the buffered frames, oldest-to-newest, into one blob the backend can split:
        /// <c>[uint32 count][uint32 len]×count][frame bytes…]</c> (little-endian). Null when empty.
        /// </summary>
        public byte[] PackLatest()
        {
            var all = new List<byte[]>();
            lock (_lock)
            {
                int count = _wrapped ? _ring.Length : _next;
                int start = _wrapped ? _next : 0;
                for (int i = 0; i < count; i++)
                {
                    byte[] f = _ring[(start + i) % _ring.Length];
                    if (f != null) all.Add(f);
                }
            }
            if (all.Count == 0) return null;

            // Budget from the newest frame backwards. An oversized clip gets the whole report rejected by the
            // server (413) — screenshot and logs with it — so trim here instead, dropping the OLDEST seconds:
            // what happened right before the tester hit Report is the part worth keeping.
            int budget = Mathf.Max(256 * 1024, BugReporter.Config.ClipMaxBytes);
            int total = 4, first = all.Count;
            for (int i = all.Count - 1; i >= 0; i--)
            {
                int cost = all[i].Length + 4;          // frame bytes + its length prefix
                if (total + cost > budget) break;
                total += cost;
                first = i;
            }
            if (first >= all.Count) return null;       // even one frame doesn't fit — send no clip at all

            var frames = all.GetRange(first, all.Count - first);
            if (frames.Count < all.Count)
            {
                Debug.LogWarning($"[BugReporter] Clip trimmed {all.Count}→{frames.Count} frames " +
                    $"(~{frames.Count / Mathf.Max(1, Fps)}s, {total / 1048576f:F1}MB) to fit ClipMaxBytes. " +
                    "Lower ClipSeconds/ClipMaxWidth if you want the full window.");
            }

            using var ms = new MemoryStream(total);
            using var bw = new BinaryWriter(ms);   // BinaryWriter is little-endian on every platform
            bw.Write((uint)frames.Count);
            foreach (var f in frames) bw.Write((uint)f.Length);
            foreach (var f in frames) bw.Write(f);
            bw.Flush();
            return ms.ToArray();
        }

        private void OnDestroy() => StopAllCoroutines();
    }
}
