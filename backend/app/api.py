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

from flask import Blueprint, g, jsonify, request, send_file

from . import db
from .ingest import UPLOAD_ROOT

bp = Blueprint("api", __name__)

SESSION_TTL = 30 * 24 * 3600


# ── auth plumbing ───────────────────────────────────────────────────────────

def _set_session(resp, token: str):
    resp.set_cookie("br_session", token, max_age=SESSION_TTL,
                    httponly=True, samesite="Lax", secure=True)


def require_user(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        token = request.cookies.get("br_session", "")
        if token:
            with db.connect() as conn:
                row = conn.execute(
                    """SELECT u.id, u.email, u.role FROM sessions s
                       JOIN users u ON u.id = s.user_id
                       WHERE s.token = ? AND s.expires_at > ?""",
                    (token, db.now()),
                ).fetchone()
            if row:
                g.user = dict(row)
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


# ── issues ──────────────────────────────────────────────────────────────────

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
        # Same multiplayer session, other devices — the other half/halves of one incident.
        siblings = []
        if row["session"]:
            siblings = conn.execute(
                """SELECT id, title, severity, status, platform, device_model, has_screenshot, created_at
                   FROM issues WHERE project_id = ? AND session = ? AND id <> ?
                   ORDER BY created_at""",
                (row["project_id"], row["session"], iid),
            ).fetchall()
    out = dict(row)
    out["metadata"] = json.loads(out["metadata"] or "{}")
    out["comments"] = [dict(c) for c in comments]
    out["siblings"] = [dict(s) for s in siblings]
    return jsonify(out)


@bp.patch("/api/issues/<iid>")
@require_user
def update_issue(iid):
    body = request.get_json(silent=True) or {}
    status = body.get("status")
    if status not in ("open", "fixed_in_build", "verified", "wont_fix"):
        return jsonify(error="bad status"), 400
    fixed_in = str(body.get("fixedInBuild") or "")[:50] if status == "fixed_in_build" else None
    with db.connect() as conn:
        changed = conn.execute(
            "UPDATE issues SET status = ?, fixed_in_build = ?, updated_at = ? WHERE id = ?",
            (status, fixed_in, db.now(), iid)).rowcount
    if not changed:
        return jsonify(error="not found"), 404
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
    with db.connect() as conn:
        row = conn.execute("SELECT project_id FROM issues WHERE id = ?", (iid,)).fetchone()
    if row is None:
        return jsonify(error="not found"), 404
    # Path is built from validated DB ids + a fixed filename — no client-supplied path parts.
    path = os.path.join(UPLOAD_ROOT, row["project_id"], iid, filename)
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
    with db.connect() as conn:
        row = conn.execute("SELECT project_id FROM issues WHERE id = ?", (iid,)).fetchone()
    if row is None:
        return None
    return os.path.join(UPLOAD_ROOT, row["project_id"], iid, "clip")


@bp.get("/api/issues/<iid>/clip")
@require_user
def clip_meta(iid):
    d = _clip_dir(iid)
    if d is None:
        return jsonify(error="not found"), 404
    frames = len([n for n in os.listdir(d)]) if os.path.isdir(d) else 0
    return jsonify(frames=frames)


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
                        AND i.build_version = b.version AND i.status = 'open') AS open_count
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
                      COUNT(CASE WHEN status = 'open' THEN 1 END) AS open_count
               FROM issues
               WHERE project_id = ? AND game <> ''
               GROUP BY game ORDER BY game""", (pid,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])
