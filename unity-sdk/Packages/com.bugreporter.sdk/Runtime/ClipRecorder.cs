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
            r._quality = Mathf.Clamp(cfg.ClipQuality, 1, 100);
            r._maxW = Mathf.Clamp(cfg.ClipMaxWidth, 120, 1280);
            r._flipY = cfg.ClipFlipY;

            if (SystemInfo.supportsAsyncGPUReadback)
            {
                r.StartCoroutine(r.CaptureLoop());
                Debug.Log($"[BugReporter] Clip recording on — last {cfg.ClipSeconds}s at {fps}fps ({frames} frames).");
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
            var frames = new List<byte[]>();
            lock (_lock)
            {
                int count = _wrapped ? _ring.Length : _next;
                int start = _wrapped ? _next : 0;
                for (int i = 0; i < count; i++)
                {
                    byte[] f = _ring[(start + i) % _ring.Length];
                    if (f != null) frames.Add(f);
                }
            }
            if (frames.Count == 0) return null;

            using var ms = new MemoryStream();
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
