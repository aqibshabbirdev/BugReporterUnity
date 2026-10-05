"""APK downloads for testers and the client: https://pandabugsreporting.com/download

Upload an APK with the hybridclr@ FTP account into its `apk/` folder (BR_HOTUPDATE_DIR/apk) — nothing else.
The page lists the newest APK first (by upload time) with a big download button, and the older ones below.
An optional `<same name>.txt` next to an APK is shown as its notes ("what's new").

  /download               the page
  /download/latest.apk    always the newest APK (a link that never changes)
  /download/<name>.apk    one specific APK
"""
import datetime
import html
import os

from flask import Blueprint, abort, send_from_directory

from .hotupdate import _root

bp = Blueprint("downloads", __name__)
MAX_OLDER = 10
APK_TYPE = "application/vnd.android.package-archive"


def _apk_dir():
    return os.environ.get("BR_APK_DIR") or os.path.join(_root(), "apk")


def _apks():
    d = _apk_dir()
    try:
        names = [n for n in os.listdir(d) if n.lower().endswith(".apk") and not n.startswith(".")]
    except FileNotFoundError:
        return []
    out = []
    for n in names:
        st = os.stat(os.path.join(d, n))
        notes = ""
        txt = os.path.join(d, n[:-4] + ".txt")
        if os.path.isfile(txt):
            with open(txt, encoding="utf-8", errors="replace") as fh:
                notes = fh.read(4000).strip()
        out.append({"name": n, "size": st.st_size, "mtime": st.st_mtime, "notes": notes})
    return sorted(out, key=lambda a: a["mtime"], reverse=True)


def _send(name):
    resp = send_from_directory(_apk_dir(), name, conditional=True, max_age=0, as_attachment=True,
                               download_name=name, mimetype=APK_TYPE)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@bp.get("/download/latest.apk")
def latest():
    apks = _apks()
    if not apks:
        abort(404)
    return _send(apks[0]["name"])


@bp.get("/download/<name>")
def one(name):
    if name.startswith(".") or "/" in name or not name.lower().endswith(".apk"):
        abort(404)
    if not os.path.isfile(os.path.join(_apk_dir(), name)):
        abort(404)
    return _send(name)


def _mb(n):
    return f"{n / 1048576:.0f} MB"


def _when(ts):
    # Server time is UTC; testers are in Pakistan (UTC+5).
    t = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc) + datetime.timedelta(hours=5)
    return t.strftime("%d %b %Y, %I:%M %p") + " PKT"


@bp.get("/download")
@bp.get("/download/")
def page():
    apks = _apks()
    e = html.escape
    if apks:
        a = apks[0]
        notes = f'<pre class="notes">{e(a["notes"])}</pre>' if a["notes"] else ""
        latest_html = f"""
<section class="card">
  <div class="label">Latest build</div>
  <h2>{e(a["name"])}</h2>
  <div class="meta">{_mb(a["size"])} · uploaded {_when(a["mtime"])}</div>
  {notes}
  <a class="btn" href="/download/latest.apk">Download APK</a>
</section>"""
        rows = "".join(
            f'<li><a href="/download/{e(o["name"])}">{e(o["name"])}</a>'
            f'<span>{_mb(o["size"])} · {_when(o["mtime"])}</span></li>'
            for o in apks[1:1 + MAX_OLDER])
        older = f'<h3>Older builds</h3><ul class="older">{rows}</ul>' if rows else ""
    else:
        latest_html = '<section class="card"><div class="meta">No APK uploaded yet.</div></section>'
        older = ""
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>GamesPanda APK</title>
<style>
:root {{ --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5d6470; --line:#e3e6ea; --accent:#1f7a4d; --on:#fff; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#111317; --card:#1b1e24; --text:#eceef2; --muted:#9aa1ad; --line:#2a2e36; --accent:#37a26b; --on:#fff; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }}
main {{ max-width:640px; margin:0 auto; padding:32px 16px 48px; }}
h1 {{ font-size:22px; margin:0 0 4px; }}
.sub {{ color:var(--muted); margin:0 0 24px; font-size:14px; }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }}
.label {{ color:var(--accent); font-weight:600; font-size:13px; text-transform:uppercase; letter-spacing:.04em; }}
h2 {{ font-size:18px; margin:6px 0 2px; word-break:break-all; }}
.meta {{ color:var(--muted); font-size:14px; }}
.notes {{ white-space:pre-wrap; font:14px/1.5 inherit; font-family:inherit; background:var(--bg); border-radius:8px; padding:12px; margin:14px 0 0; }}
.btn {{ display:block; text-align:center; margin-top:18px; background:var(--accent); color:var(--on); text-decoration:none; font-weight:600; padding:14px; border-radius:10px; }}
h3 {{ font-size:15px; margin:28px 0 8px; }}
.older {{ list-style:none; padding:0; margin:0; border:1px solid var(--line); border-radius:12px; background:var(--card); }}
.older li {{ padding:12px 16px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:2px; }}
.older li:first-child {{ border-top:0; }}
.older a {{ color:var(--text); word-break:break-all; }}
.older span {{ color:var(--muted); font-size:13px; }}
.help {{ color:var(--muted); font-size:13px; margin-top:28px; }}
</style></head><body><main>
<h1>GamesPanda for Android</h1>
<p class="sub">Test builds for testers and the client.</p>
{latest_html}
{older}
<p class="help">On the phone: open the downloaded file and allow "Install unknown apps" for your browser if Android asks.</p>
</main></body></html>"""
    return body, 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"}
