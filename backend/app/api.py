"""Dashboard API: session auth, issues, builds, comments, project settings.

Auth model (deliberately small for a single-team MVP):
- First user to register becomes admin; registration then locks unless an admin creates an invite.
- Session = opaque token in an HttpOnly cookie, 30 days.
"""
import functools
import json
import os
import secrets
import shutil
import time
from functools import lru_cache

from flask import Blueprint, g, jsonify, request, send_file

from . import db
from .ingest import UPLOAD_ROOT

bp = Blueprint("api", __name__)

SESSION_TTL = 30 * 24 * 3600


# ── connection-saving caches ─────────────────────────────────────────────────
# The managed MySQL has a small connection cap, and PyMySQL opens a fresh connection per db.connect().
# A single clip playback fetches hundreds of frames back-to-back; without these caches each frame cost
# two connections (auth + path lookup) and a burst exhausted the pool — every request, login included,
# then 500'd with "Too many connections". These keep asset serving off the DB almost entirely.

@lru_cache(maxsize=8192)
def _project_of(iid: str):
    """issue id -> project id. Immutable, so cache forever. A deleted issue just resolves to a missing
    path and 404s, which is the same result as a cache miss."""
    with db.connect() as conn:
        row = conn.execute("SELECT project_id FROM issues WHERE id = ?", (iid,)).fetchone()
    return row["project_id"] if row else None


_session_cache: dict[str, tuple[float, dict]] = {}
SESSION_CACHE_TTL = 30      # seconds — a burst of asset requests shares one auth lookup


# ── auth plumbing ───────────────────────────────────────────────────────────

def _set_session(resp, token: str):
    resp.set_cookie("br_session", token, max_age=SESSION_TTL,
                    httponly=True, samesite="Lax", secure=True)


def require_user(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        token = request.cookies.get("br_session", "")
        if token:
            now = time.time()
            hit = _session_cache.get(token)
            if hit and hit[0] > now:
                g.user = hit[1]
                return fn(*args, **kwargs)
            with db.connect() as conn:
                row = conn.execute(
                    """SELECT u.id, u.email, u.role FROM sessions s
                       JOIN users u ON u.id = s.user_id
                       WHERE s.token = ? AND s.expires_at > ?""",
                    (token, db.now()),
                ).fetchone()
            if row:
                g.user = dict(row)
                _session_cache[token] = (now + SESSION_CACHE_TTL, g.user)
                return fn(*args, **kwargs)
        return jsonify(error="not signed in"), 401
    return wrapper


@bp.post("/api/auth/register")
def register():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    invite = str(body.get("invite") or "")
    if "@" not in email or len(password) < 8:
        return jsonify(error="valid email and a password of 8+ chars required"), 400

    with db.connect() as conn:
        first_user = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 0
        if not first_user:
            expected = os.environ.get("BR_INVITE_CODE", "")
            if not expected or invite != expected:
                return jsonify(error="registration is invite-only"), 403
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            return jsonify(error="email already registered"), 409

        uid = db.new_id()
        conn.execute(
            "INSERT INTO users (id, email, pw_hash, role, created_at) VALUES (?,?,?,?,?)",
            (uid, email, db.hash_password(password), "admin" if first_user else "dev", db.now()),
        )
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
                     (token, uid, db.now() + SESSION_TTL))

    resp = jsonify(email=email, role="admin" if first_user else "dev")
    _set_session(resp, token)
    return resp, 201


@bp.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    with db.connect() as conn:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if user is None or not db.verify_password(password, user["pw_hash"]):
            return jsonify(error="wrong email or password"), 401
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
                     (token, user["id"], db.now() + SESSION_TTL))
    resp = jsonify(email=user["email"], role=user["role"])
    _set_session(resp, token)
    return resp


@bp.post("/api/auth/logout")
@require_user
def logout():
    token = request.cookies.get("br_session", "")
    with db.connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    _session_cache.pop(token, None)          # don't let the cache keep a signed-out token alive
    resp = jsonify(ok=True)
    resp.delete_cookie("br_session")
    return resp


@bp.get("/api/auth/me")
@require_user
def me():
    return jsonify(g.user)


# ── projects ────────────────────────────────────────────────────────────────

@bp.get("/api/projects")
@require_user
def list_projects():
    with db.connect() as conn:
        rows = conn.execute("SELECT id, name, created_at FROM projects ORDER BY created_at").fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/api/projects")
@require_user
def create_project():
    if g.user["role"] != "admin":
        return jsonify(error="admin only"), 403
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()[:80]
    if not name:
        return jsonify(error="name required"), 400
    key = db.make_api_key()
    pid = db.new_id()
    with db.connect() as conn:
        conn.execute("INSERT INTO projects (id, name, api_key_hash, created_at) VALUES (?,?,?,?)",
                     (pid, name, db.hash_api_key(key), db.now()))
    # The one and only time the plaintext key leaves the server.
    return jsonify(id=pid, name=name, apiKey=key), 201


# ── storage / retention ─────────────────────────────────────────────────────

@bp.get("/api/storage")
@require_user
def storage():
    from . import retention
    clip_days, full_days = retention.retain_days()
    return jsonify(bytes=retention.usage_bytes(), clip_days=clip_days, retain_days=full_days)


@bp.post("/api/storage/cleanup")
@require_user
def storage_cleanup():
    if g.user["role"] != "admin":
        return jsonify(error="admin only"), 403
    from . import retention
    out = retention.purge()
    out["bytes"] = retention.usage_bytes()
    return jsonify(out)


@bp.post("/api/projects/<pid>/rotate-key")
@require_user
def rotate_key(pid):
    if g.user["role"] != "admin":
        return jsonify(error="admin only"), 403
    key = db.make_api_key()
    with db.connect() as conn:
        changed = conn.execute("UPDATE projects SET api_key_hash = ? WHERE id = ?",
                               (db.hash_api_key(key), pid)).rowcount
    if not changed:
        return jsonify(error="no such project"), 404
    return jsonify(apiKey=key)


# ── export (API-key auth, for QA tooling / automation) ───────────────────────
# Every dashboard read needs a browser session; this is the one read that takes the project's X-Api-Key
# (the same key the game ships with) so a script/CI/test tool can pull issues and their test cases without
# a login. It's scoped to that one project. Note: it makes the write key also readable — fine for an
# internal tool; rotate the key if a build leaks.

@bp.get("/api/export")
def export_issues():
    api_key = request.headers.get("X-Api-Key", "")
    if not api_key.startswith("br_"):
        return jsonify(error="missing or malformed X-Api-Key"), 401
    with db.connect() as conn:
        project = conn.execute(
            "SELECT id, name FROM projects WHERE api_key_hash = ?", (db.hash_api_key(api_key),)
        ).fetchone()
    if project is None:
        return jsonify(error="unknown api key"), 401

    q = """SELECT id, title, description, test_case, severity, status, fixed_in_build,
                  build_version, game, session, platform, device_model, os_version,
                  has_screenshot, has_logs, has_clip, created_at, updated_at
           FROM issues WHERE project_id = ?"""
    params: list = [project["id"]]
    if request.args.get("status"):
        q += " AND status = ?"; params.append(request.args["status"])
    if request.args.get("game"):
        q += " AND game = ?"; params.append(request.args["game"])
    if request.args.get("since"):
        try:
            params.append(int(request.args["since"])); q += " AND created_at >= ?"
        except (TypeError, ValueError):
            return jsonify(error="`since` must be a unix timestamp"), 400
    if request.args.get("with_test_case"):
        q += " AND test_case IS NOT NULL AND test_case <> ''"
    q += " ORDER BY created_at DESC LIMIT 2000"

    with db.connect() as conn:
        rows = conn.execute(q, params).fetchall()
    issues = []
    for r in rows:
        d = dict(r)
        d["tester_note"] = d.pop("description", "") or ""   # clearer name in the export
        issues.append(d)
    return jsonify(project=project["name"], count=len(issues), issues=issues)


# ── issues ──────────────────────────────────────────────────────────────────

# The workflow the team actually runs, in order: a report lands in `open`, a dev moves it to
# `pending` while working on it, to `waiting_for_test` once a build carries the fix, and whoever
# retests closes it. Anything not `closed` still needs someone — that's what the "N open" counters
# on the build/game filters mean. Legacy values are remapped on boot by db._migrate.
STATUSES = ("open", "pending", "waiting_for_test", "closed")

# Reports of one multiplayer bug land from both devices within seconds; a different bug later in the
# same match is minutes away. This window (seconds) separates the two. Mirrors CLUSTER_WINDOW on the client.
INCIDENT_WINDOW = 120


@bp.get("/api/projects/<pid>/issues")
@require_user
def list_issues(pid):
    q = "SELECT id, title, severity, status, fixed_in_build, build_version, game, session, platform, has_screenshot, created_at FROM issues WHERE project_id = ?"
    params: list = [pid]
    if request.args.get("build"):
        q += " AND build_version = ?"; params.append(request.args["build"])
    if request.args.get("game"):
        q += " AND game = ?"; params.append(request.args["game"])
    if request.args.get("status"):
        q += " AND status = ?"; params.append(request.args["status"])
    q += " ORDER BY created_at DESC LIMIT 500"
    with db.connect() as conn:
        rows = conn.execute(q, params).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.get("/api/issues/<iid>")
@require_user
def issue_detail(iid):
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM issues WHERE id = ?", (iid,)).fetchone()
        if row is None:
            return jsonify(error="not found"), 404
        comments = conn.execute(
            "SELECT author, text, created_at FROM comments WHERE issue_id = ? ORDER BY created_at", (iid,)
        ).fetchall()
        # Other devices in the SAME incident: same session AND reported close in time. A tester files
        # several different bugs in one match, so session alone would wrongly merge them — the ±window
        # keeps only the reports of this one bug (both devices reacting to the same moment).
        siblings = []
        if row["session"]:
            siblings = conn.execute(
                """SELECT id, title, severity, status, platform, device_model, metadata,
                          has_screenshot, has_logs, created_at
                   FROM issues WHERE project_id = ? AND session = ? AND id <> ?
                     AND ABS(created_at - ?) <= ?
                   ORDER BY created_at""",
                (row["project_id"], row["session"], iid, row["created_at"], INCIDENT_WINDOW),
            ).fetchall()
    out = dict(row)
    out["metadata"] = json.loads(out["metadata"] or "{}")
    out["side"] = str(out["metadata"].get("side") or "")   # Creator / Joiner, from the game's role metadata
    out["comments"] = [dict(c) for c in comments]

    sib_list = []
    for s in siblings:
        d = dict(s)
        meta = json.loads(d.pop("metadata", None) or "{}")   # drop raw metadata, surface just the side
        d["side"] = str(meta.get("side") or "")
        sib_list.append(d)
    out["siblings"] = sib_list
    return jsonify(out)


@bp.patch("/api/issues/<iid>")
@require_user
def update_issue(iid):
    body = request.get_json(silent=True) or {}
    status = body.get("status")
    if status not in STATUSES:
        return jsonify(error="bad status"), 400
    fixed_in = str(body.get("fixedInBuild") or "").strip()[:50]

    # fixed_in_build has to SURVIVE the move to closed — you want to know which build the fix shipped
    # in long after the tester signed it off. The old code rewrote the column on every PATCH, so
    # closing an issue erased that. Only these three cases touch it.
    if status in ("open", "pending"):
        sql = "UPDATE issues SET status = ?, fixed_in_build = NULL, updated_at = ? WHERE id = ?"
        params = (status, db.now(), iid)          # reopened/back in progress — no fix stands any more
    elif fixed_in:
        sql = "UPDATE issues SET status = ?, fixed_in_build = ?, updated_at = ? WHERE id = ?"
        params = (status, fixed_in, db.now(), iid)
    else:
        sql = "UPDATE issues SET status = ?, updated_at = ? WHERE id = ?"
        params = (status, db.now(), iid)          # keep whatever build is already stamped

    with db.connect() as conn:
        # Existence check rather than rowcount: PyMySQL reports rows *changed*, so re-applying the
        # status an issue already has would otherwise 404.
        if conn.execute("SELECT 1 FROM issues WHERE id = ?", (iid,)).fetchone() is None:
            return jsonify(error="not found"), 404
        conn.execute(sql, params)
    return jsonify(ok=True)


@bp.patch("/api/issues/<iid>/notes")
@require_user
def set_notes(iid):
    # Dev-written test case — a separate field from the tester's in-game note (description), so saving it
    # never overwrites what the tester originally reported.
    notes = str((request.get_json(silent=True) or {}).get("notes") or "")[:4000]
    with db.connect() as conn:
        if conn.execute("SELECT 1 FROM issues WHERE id = ?", (iid,)).fetchone() is None:
            return jsonify(error="not found"), 404
        conn.execute("UPDATE issues SET test_case = ?, updated_at = ? WHERE id = ?", (notes, db.now(), iid))
    return jsonify(ok=True)


@bp.delete("/api/issues/<iid>")
@require_user
def delete_issue(iid):
    # Deletion is guarded by a confirm code on top of the login, so a stray click can't wipe a report.
    # Default is "Queen@21"; override with the BR_DELETE_CODE env var for a private one.
    code = str((request.get_json(silent=True) or {}).get("code") or "")
    if code != os.environ.get("BR_DELETE_CODE", "Queen@21"):
        return jsonify(error="wrong delete password"), 403
    with db.connect() as conn:
        row = conn.execute("SELECT project_id FROM issues WHERE id = ?", (iid,)).fetchone()
        if row is None:
            return jsonify(error="not found"), 404
        conn.execute("DELETE FROM comments WHERE issue_id = ?", (iid,))
        conn.execute("DELETE FROM issues WHERE id = ?", (iid,))
    # Best-effort file cleanup — the DB row is already gone, so a failed unlink just leaves orphaned bytes.
    shutil.rmtree(os.path.join(UPLOAD_ROOT, row["project_id"], iid), ignore_errors=True)
    return jsonify(ok=True)


@bp.post("/api/issues/<iid>/comments")
@require_user
def add_comment(iid):
    text = str((request.get_json(silent=True) or {}).get("text") or "").strip()[:2000]
    if not text:
        return jsonify(error="text required"), 400
    with db.connect() as conn:
        if conn.execute("SELECT 1 FROM issues WHERE id = ?", (iid,)).fetchone() is None:
            return jsonify(error="not found"), 404
        conn.execute("INSERT INTO comments (id, issue_id, author, text, created_at) VALUES (?,?,?,?,?)",
                     (db.new_id(), iid, g.user["email"], text, db.now()))
    return jsonify(ok=True), 201


# ── attachments ─────────────────────────────────────────────────────────────

def _attachment(iid: str, filename: str):
    pid = _project_of(iid)
    if pid is None:
        return jsonify(error="not found"), 404
    # Path is built from validated DB ids + a fixed filename — no client-supplied path parts.
    path = os.path.join(UPLOAD_ROOT, pid, iid, filename)
    if not os.path.exists(path):
        return jsonify(error="no such attachment"), 404
    return send_file(path)


@bp.get("/api/issues/<iid>/screenshot.jpg")
@require_user
def screenshot(iid):
    return _attachment(iid, "screenshot.jpg")


@bp.get("/api/issues/<iid>/thumb.jpg")
@require_user
def thumb(iid):
    # Small grid preview. Reports from the updated SDK ship a thumb.jpg; older ones fall back to the full
    # screenshot so nothing 404s (they're just heavier until re-reported).
    with db.connect() as conn:
        row = conn.execute("SELECT project_id FROM issues WHERE id = ?", (iid,)).fetchone()
    if row is None:
        return jsonify(error="not found"), 404
    base = os.path.join(UPLOAD_ROOT, row["project_id"], iid)
    for name in ("thumb.jpg", "screenshot.jpg"):
        path = os.path.join(base, name)
        if os.path.exists(path):
            return send_file(path)
    return jsonify(error="no such attachment"), 404


@bp.get("/api/issues/<iid>/logs.txt")
@require_user
def logs(iid):
    return _attachment(iid, "logs.txt")


def _clip_dir(iid: str):
    pid = _project_of(iid)                    # cached — a clip is hundreds of frame requests
    return os.path.join(UPLOAD_ROOT, pid, iid, "clip") if pid else None


@bp.get("/api/issues/<iid>/clip")
@require_user
def clip_meta(iid):
    d = _clip_dir(iid)
    if d is None:
        return jsonify(error="not found"), 404
    if not os.path.isdir(d):
        return jsonify(frames=0, fps=0)
    # Count frames only — the dir also holds the `fps` marker file.
    frames = len([n for n in os.listdir(d) if n.endswith(".jpg")])
    fps = 6
    try:
        with open(os.path.join(d, "fps")) as f:
            fps = int(f.read().strip())
    except (OSError, ValueError):
        pass                                  # older clips predate the marker — 6 was the default then
    return jsonify(frames=frames, fps=max(1, min(fps, 60)))


@bp.get("/api/issues/<iid>/clip/<int:n>.jpg")
@require_user
def clip_frame(iid, n):
    d = _clip_dir(iid)
    if d is None:
        return jsonify(error="not found"), 404
    # n comes from an <int:> route rule, so it's already an integer — no path-traversal surface.
    path = os.path.join(d, f"{n:03d}.jpg")
    if not os.path.exists(path):
        return jsonify(error="no such frame"), 404
    return send_file(path)


# ── builds ──────────────────────────────────────────────────────────────────

@bp.get("/api/projects/<pid>/builds")
@require_user
def list_builds(pid):
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT version, platform, first_seen_at, report_count,
                      (SELECT COUNT(*) FROM issues i WHERE i.project_id = b.project_id
                        AND i.build_version = b.version AND i.status <> 'closed') AS open_count
               FROM builds b WHERE project_id = ? ORDER BY first_seen_at DESC""", (pid,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])


# ── games ─────────────────────────────────────────────────────────────────────
# No registry table — a "game" is just a value the SDK stamps on each issue. Derive the filter
# list straight from the issues that carry one (blank = SDK never called SetGame).

@bp.get("/api/projects/<pid>/games")
@require_user
def list_games(pid):
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT game,
                      COUNT(*) AS report_count,
                      COUNT(CASE WHEN status <> 'closed' THEN 1 END) AS open_count
               FROM issues
               WHERE project_id = ? AND game <> ''
               GROUP BY game ORDER BY game""", (pid,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])
