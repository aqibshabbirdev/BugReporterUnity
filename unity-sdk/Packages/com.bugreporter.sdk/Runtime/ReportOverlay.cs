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
        private string _note = "";      // the tester's optional note → travels as the report's description
        private bool _justSent;
        private float _sentAt;
        private GUIStyle _btn, _label, _field;

        // One-tap categories: the tester has no time to type mid-game, so tapping a tag files the report
        // immediately with a sensible severity. The category is the title; the note (if any) is the description.
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
            BugReporter.ReportFromOverlay(title, _note.Trim(), severity);   // the note becomes the description
            _note = "";
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
                    _note = "";
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

            // Note FIRST — whatever the tester types here rides along as the description on WHICHEVER category
            // they then tap. (The old form threw the note away when a quick tag was tapped.)
            GUILayout.Label("Note (optional) — what happened, in your words:", _label);
            GUI.SetNextControlName("bugNote");
            _note = GUILayout.TextField(_note, 300, _field, GUILayout.Height(Screen.height * 0.10f));

            GUILayout.Space(12f);
            GUILayout.Label("Tap a category to send:", _label);
            float th = Screen.height * 0.09f;
            for (int i = 0; i < QuickTags.Length; i += 2)
            {
                GUILayout.BeginHorizontal();
                for (int j = i; j < i + 2 && j < QuickTags.Length; j++)
                    if (GUILayout.Button(QuickTags[j].label, _btn, GUILayout.Height(th)))
                        SendReport(QuickTags[j].label, QuickTags[j].sev);   // title = category, description = note
                GUILayout.EndHorizontal();
            }

            GUILayout.FlexibleSpace();
            if (GUILayout.Button("Cancel", _btn, GUILayout.Height(Screen.height * 0.07f)))
            {
                _formOpen = false;
                _note = "";
            }
            GUILayout.EndArea();
        }
    }
}
