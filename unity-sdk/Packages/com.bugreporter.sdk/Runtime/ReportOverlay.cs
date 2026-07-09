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
            float w = Screen.width * 0.6f, h = Screen.height * 0.42f;
            var box = new Rect((Screen.width - w) / 2f, (Screen.height - h) / 2f, w, h);

            // Modal scrim: swallow clicks behind the form so tapping the field can't also swing the bat.
            GUI.Box(new Rect(0, 0, Screen.width, Screen.height), GUIContent.none);
            GUI.Box(box, GUIContent.none);

            GUILayout.BeginArea(new Rect(box.x + 16f, box.y + 16f, box.width - 32f, box.height - 32f));
            GUILayout.Label("What went wrong?", _label);
            GUILayout.Space(6f);

            GUI.SetNextControlName("bugTitle");
            _title = GUILayout.TextField(_title, 140, _field, GUILayout.Height(Screen.height * 0.07f));
            if (Event.current.type == EventType.Repaint) GUI.FocusControl("bugTitle");

            GUILayout.Space(10f);
            GUILayout.Label("Severity", _label);
            GUILayout.BeginHorizontal();
            foreach (Severity s in new[] { Severity.Low, Severity.Normal, Severity.High, Severity.Crash })
            {
                bool on = _severity == s;
                var style = new GUIStyle(_btn);
                if (on) style.normal.textColor = Color.yellow;
                if (GUILayout.Button(on ? $"● {s}" : s.ToString(), style, GUILayout.Height(Screen.height * 0.06f)))
                    _severity = s;
            }
            GUILayout.EndHorizontal();

            GUILayout.FlexibleSpace();
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Cancel", _btn, GUILayout.Height(Screen.height * 0.07f)))
                _formOpen = false;
            GUILayout.Space(12f);
            GUI.enabled = !string.IsNullOrWhiteSpace(_title);
            if (GUILayout.Button("Send", _btn, GUILayout.Height(Screen.height * 0.07f)))
            {
                // Close first: the screenshot is taken at end-of-frame, and the form must not be in it.
                _formOpen = false;
                _justSent = true;
                _sentAt = Time.unscaledTime;
                BugReporter.ReportFromOverlay(_title.Trim(), _severity);
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();
            GUILayout.EndArea();
        }
    }
}
