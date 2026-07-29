using UnityEngine;

namespace BugReporter
{
    /// <summary>
    /// The floating "🐞 Report" button and its one-field form. Drawn with OnGUI so a game needs zero prefabs,
    /// zero canvases and zero scene edits to adopt the SDK — the same zero-setup rule as the rest of the package.
    /// Replace with your own UI by setting <c>ShowReportButton = false</c> and calling <see cref="BugReporter.Report"/>.
    /// </summary>
    internal sealed class ReportOverlay : MonoBehaviour
    {
        private bool _formOpen;
        private string _title = "";
        private Severity _severity = Severity.Normal;
        private bool _justSent;
        private float _sentAt;
        private GUIStyle _btn, _label, _field;

        // One-tap categories: the tester has no time to type mid-game, so tapping a tag files the report
        // immediately with a sensible severity. Repro steps get written later on the dashboard.
        private static readonly (string label, Severity sev)[] QuickTags =
        {
            ("💥 Crash",        Severity.Crash),
            ("🧊 Freeze / Stuck", Severity.High),
            ("❌ Wrong result", Severity.High),
            ("🎨 Visual bug",   Severity.Normal),
            ("📶 Lag / Network", Severity.Normal),
            ("❓ Other",         Severity.Normal),
        };

        private void SendReport(string title, Severity severity)
        {
            // Close first: the screenshot is taken at end-of-frame, and the form must not be in it.
            _formOpen = false;
            _justSent = true;
            _sentAt = Time.unscaledTime;
            BugReporter.ReportFromOverlay(title, severity);   // Report() defaults an empty title itself
            _title = "";
        }

        public static void Create()
        {
            var go = new GameObject("[BugReporter.Overlay]");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideInHierarchy;
            go.AddComponent<ReportOverlay>();
        }

        private void EnsureStyles()
        {
            if (_btn != null) return;
            int fs = Mathf.Max(12, Screen.height / 48);
            _btn   = new GUIStyle(GUI.skin.button) { fontSize = fs, fontStyle = FontStyle.Bold };
            _label = new GUIStyle(GUI.skin.label)  { fontSize = fs, wordWrap = true };
            _field = new GUIStyle(GUI.skin.textField) { fontSize = fs };
        }

        private void OnGUI()
        {
            EnsureStyles();

            if (_justSent && Time.unscaledTime - _sentAt < 2.5f)
            {
                float w = Screen.width * 0.5f;
                GUI.Label(new Rect((Screen.width - w) / 2f, Screen.height * 0.06f, w, 40f),
                          "✓ Bug report sent", _label);
                return;
            }
            _justSent = false;

            if (!_formOpen)
            {
                // Top-left, clear of the usual bottom HUD and the top-right pause/settings cluster.
                float bw = Screen.width * 0.13f, bh = Screen.height * 0.07f;
                if (GUI.Button(new Rect(12f, Screen.height * 0.18f, bw, bh), "🐞 Report", _btn))
                {
                    _formOpen = true;
                    _title = "";
                }
                return;
            }

            DrawForm();
        }

        private void DrawForm()
        {
            float w = Screen.width * 0.62f, h = Screen.height * 0.6f;
            var box = new Rect((Screen.width - w) / 2f, (Screen.height - h) / 2f, w, h);

            // Modal scrim: swallow clicks behind the form so tapping the field can't also swing the bat.
            GUI.Box(new Rect(0, 0, Screen.width, Screen.height), GUIContent.none);
            GUI.Box(box, GUIContent.none);

            GUILayout.BeginArea(new Rect(box.x + 16f, box.y + 16f, box.width - 32f, box.height - 32f));
            GUILayout.Label("What happened? Tap one — no typing needed. Add the details later on the dashboard.", _label);
            GUILayout.Space(8f);

            // Fast path: one tap files the report with a matching severity.
            float th = Screen.height * 0.08f;
            for (int i = 0; i < QuickTags.Length; i += 2)
            {
                GUILayout.BeginHorizontal();
                for (int j = i; j < i + 2 && j < QuickTags.Length; j++)
                    if (GUILayout.Button(QuickTags[j].label, _btn, GUILayout.Height(th)))
                        SendReport(QuickTags[j].label, QuickTags[j].sev);
                GUILayout.EndHorizontal();
            }

            GUILayout.Space(10f);
            GUILayout.Label("or add a note (optional):", _label);
            GUI.SetNextControlName("bugTitle");
            _title = GUILayout.TextField(_title, 140, _field, GUILayout.Height(Screen.height * 0.07f));

            GUILayout.Space(8f);
            GUILayout.BeginHorizontal();
            foreach (Severity s in new[] { Severity.Low, Severity.Normal, Severity.High, Severity.Crash })
            {
                bool on = _severity == s;
                var style = new GUIStyle(_btn);
                if (on) style.normal.textColor = Color.yellow;
                if (GUILayout.Button(on ? $"● {s}" : s.ToString(), style, GUILayout.Height(Screen.height * 0.055f)))
                    _severity = s;
            }
            GUILayout.EndHorizontal();

            GUILayout.FlexibleSpace();
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Cancel", _btn, GUILayout.Height(Screen.height * 0.07f)))
            {
                _formOpen = false;
                _title = "";
            }
            GUILayout.Space(12f);
            // Title is optional now — Report() names an empty one "(no title)". Never blocks a report.
            if (GUILayout.Button("Send", _btn, GUILayout.Height(Screen.height * 0.07f)))
                SendReport(_title.Trim(), _severity);
            GUILayout.EndHorizontal();
            GUILayout.EndArea();
        }
    }
}
