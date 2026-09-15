"""Dashboard API: session auth, teams, issues, builds, comments, project settings.

Auth and tenancy:
- Every account belongs to one team. A team sees only its own projects (and through them issues, builds,
  attachments) and its own API-tester documents; anything of another team answers 404, never 403, so ids
  can't be probed.
- Joining needs an invite code made by a team admin (team_invites). The very first account on an empty
  database creates the first team. BR_INVITE_CODE still works and joins the first team as a dev.
- The owner (users.is_owner) can create teams and hand out their first admin invite, and sees only team
  names and counts — not their data.
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


@lru_cache(maxsize=4096)
def _team_of_project(pid: str):
    """project id -> team id. A project never changes team, so this caches forever too."""
    with db.connect() as conn:
        row = conn.execute("SELECT team_id FROM projects WHERE id = ?", (pid,)).fetchone()
    return row["team_id"] if row else None


def _own_project(pid) -> bool:
    return bool(pid) and _team_of_project(pid) == g.user["team_id"]


def _own_issue(iid) -> bool:
    return _own_project(_project_of(iid))


_session_cache: dict[str, tuple[float, dict]] = {}
SESSION_CACHE_TTL = 30      # seconds — a burst of asset requests shares one auth lookup


def _forget_user(uid: str):
    """Drop cached sessions of an account whose role or membership just changed."""
    for token, (_exp, user) in list(_session_cache.items()):
        if user["id"] == uid:
            _session_cache.pop(token, None)


def _me_json(user) -> dict:
    return {"id": user["id"], "email": user["email"], "role": user["role"], "team_id": user["team_id"],
            "team_name": user["team_name"], "is_owner": bool(user["is_owner"])}


_ME_SQL = """SELECT u.id, u.email, u.role, u.team_id, u.is_owner, t.name AS team_name
             FROM users u LEFT JOIN teams t ON t.id = u.team_id"""


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
                    _ME_SQL + " JOIN sessions s ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?",
                    (token, db.now()),
                ).fetchone()
            if row and row["team_id"]:
                g.user = _me_json(row)
                _session_cache[token] = (now + SESSION_CACHE_TTL, g.user)
                return fn(*args, **kwargs)
        return jsonify(error="not signed in"), 401
    return wrapper


@bp.post("/api/auth/register")
def register():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    invite = str(body.get("invite") or "").strip()
    if "@" not in email or len(password) < 8:
        return jsonify(error="valid email and a password of 8+ chars required"), 400

    with db.connect() as conn:
        first_user = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 0
        is_owner = 0
        if first_user:                                  # empty database: this account starts the first team
            team_id, role, is_owner = db.new_id(), "admin", 1
            conn.execute("INSERT INTO teams (id, name, created_at) VALUES (?,?,?)",
                         (team_id, str(body.get("team") or db.DEFAULT_TEAM_NAME)[:80], db.now()))
        else:
            row = conn.execute("SELECT id, team_id, role FROM team_invites WHERE code = ?", (invite,)).fetchone() if invite else None
            legacy = os.environ.get("BR_INVITE_CODE", "")
            if row:
                team_id, role = row["team_id"], row["role"]
            elif legacy and invite == legacy:
                first = conn.execute("SELECT id FROM teams ORDER BY created_at LIMIT 1").fetchone()
                if not first:
                    return jsonify(error="registration is invite-only"), 403
                team_id, role = first["id"], "dev"
            else:
                return jsonify(error="registration needs a valid invite code from your team admin"), 403
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            return jsonify(error="email already registered"), 409

        uid = db.new_id()
        conn.execute(
            "INSERT INTO users (id, email, pw_hash, role, team_id, is_owner, created_at) VALUES (?,?,?,?,?,?,?)",
            (uid, email, db.hash_password(password), role, team_id, is_owner, db.now()),
        )
        if not first_user and row:
            conn.execute("UPDATE team_invites SET uses = uses + 1 WHERE id = ?", (row["id"],))
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
                     (token, uid, db.now() + SESSION_TTL))
        me = conn.execute(_ME_SQL + " WHERE u.id = ?", (uid,)).fetchone()

    resp = jsonify(_me_json(me))
    _set_session(resp, token)
    return resp, 201


@bp.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    with db.connect() as conn:
        user = conn.execute("SELECT id, pw_hash FROM users WHERE email = ?", (email,)).fetchone()
        if user is None or not db.verify_password(password, user["pw_hash"]):
            return jsonify(error="wrong email or password"), 401
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
                     (token, user["id"], db.now() + SESSION_TTL))
        me = conn.execute(_ME_SQL + " WHERE u.id = ?", (user["id"],)).fetchone()
    resp = jsonify(_me_json(me))
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


# ── team (members + invites) ────────────────────────────────────────────────

INVITE_ROLES = ("dev", "admin")


def _admin_only():
    return None if g.user["role"] == "admin" else (jsonify(error="only a team admin can do this"), 403)


@bp.get("/api/team")
@require_user
def get_team():
    tid = g.user["team_id"]
    with db.connect() as conn:
        members = conn.execute(
            "SELECT id, email, role, created_at FROM users WHERE team_id = ? ORDER BY created_at", (tid,)
        ).fetchall()
        invites = conn.execute(
            "SELECT id, code, role, created_by, created_at, uses FROM team_invites WHERE team_id = ? ORDER BY created_at DESC",
            (tid,),
        ).fetchall() if g.user["role"] == "admin" else []
    return jsonify(id=tid, name=g.user["team_name"], members=[dict(m) for m in members],
                   invites=[dict(i) for i in invites])


@bp.patch("/api/team")
@require_user
def rename_team():
    if (denied := _admin_only()):
        return denied
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()[:80]
    if not name:
        return jsonify(error="name required"), 400
    with db.connect() as conn:
        conn.execute("UPDATE teams SET name = ? WHERE id = ?", (name, g.user["team_id"]))
    _session_cache.clear()                       # team_name is part of every cached session
    return jsonify(ok=True, name=name)


def _new_invite(conn, team_id: str, role: str) -> dict:
    inv = {"id": db.new_id(), "code": "join-" + secrets.token_hex(6), "role": role,
           "created_by": g.user["email"], "created_at": db.now(), "uses": 0}
    conn.execute("INSERT INTO team_invites (id, team_id, code, role, created_by, created_at) VALUES (?,?,?,?,?,?)",
                 (inv["id"], team_id, inv["code"], role, inv["created_by"], inv["created_at"]))
    return inv


@bp.post("/api/team/invites")
@require_user
def create_invite():
    if (denied := _admin_only()):
        return denied
    role = (request.get_json(silent=True) or {}).get("role") or "dev"
    if role not in INVITE_ROLES:
        return jsonify(error="role must be dev or admin"), 400
    with db.connect() as conn:
        inv = _new_invite(conn, g.user["team_id"], role)
    return jsonify(inv), 201


@bp.delete("/api/team/invites/<inv_id>")
@require_user
def revoke_invite(inv_id):
    if (denied := _admin_only()):
        return denied
    with db.connect() as conn:
        n = conn.execute("DELETE FROM team_invites WHERE id = ? AND team_id = ?", (inv_id, g.user["team_id"])).rowcount
    return (jsonify(ok=True), 200) if n else (jsonify(error="not found"), 404)


@bp.patch("/api/team/members/<uid>")
@require_user
def set_member_role(uid):
    if (denied := _admin_only()):
        return denied
    role = (request.get_json(silent=True) or {}).get("role")
    if role not in INVITE_ROLES:
        return jsonify(error="role must be dev or admin"), 400
    if uid == g.user["id"]:
        return jsonify(error="ask another admin to change your own role"), 400
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE id = ? AND team_id = ?", (uid, g.user["team_id"])).fetchone():
            return jsonify(error="not found"), 404
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, uid))
    _forget_user(uid)
    return jsonify(ok=True)


@bp.delete("/api/team/members/<uid>")
@require_user
def remove_member(uid):
    if (denied := _admin_only()):
        return denied
    if uid == g.user["id"]:
        return jsonify(error="you can't remove yourself"), 400
    with db.connect() as conn:
        row = conn.execute("SELECT is_owner FROM users WHERE id = ? AND team_id = ?", (uid, g.user["team_id"])).fetchone()
        if not row:
            return jsonify(error="not found"), 404
        if row["is_owner"]:
            return jsonify(error="the owner account can't be removed"), 400
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
        conn.execute("UPDATE issues SET assignee_id = NULL WHERE assignee_id = ?", (uid,))   # back to unassigned
        conn.execute("DELETE FROM users WHERE id = ?", (uid,))
    _forget_user(uid)
    return jsonify(ok=True)


# ── teams (owner only: create teams; sees names and counts, not their data) ───

@bp.get("/api/teams")
@require_user
def list_teams():
    if not g.user["is_owner"]:
        return jsonify(error="owner only"), 403
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT t.id, t.name, t.created_at,
                      (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS members,
                      (SELECT COUNT(*) FROM projects p WHERE p.team_id = t.id) AS projects
               FROM teams t ORDER BY t.created_at"""
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/api/teams")
@require_user
def create_team():
    if not g.user["is_owner"]:
        return jsonify(error="owner only"), 403
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()[:80]
    if not name:
        return jsonify(error="name required"), 400
    tid = db.new_id()
    with db.connect() as conn:
        if conn.execute("SELECT 1 FROM teams WHERE name = ?", (name,)).fetchone():
            return jsonify(error="a team with that name already exists"), 409
        conn.execute("INSERT INTO teams (id, name, created_at) VALUES (?,?,?)", (tid, name, db.now()))
        inv = _new_invite(conn, tid, "admin")
    # The owner is not a member of the new team: this admin invite is the one way in.
    return jsonify(id=tid, name=name, invite=inv), 201


# ── projects ────────────────────────────────────────────────────────────────

@bp.get("/api/projects")
@require_user
def list_projects():
    with db.connect() as conn:
        rows = conn.execute("SELECT id, name, created_at FROM projects WHERE team_id = ? ORDER BY created_at",
                            (g.user["team_id"],)).fetchall()
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
        conn.execute("INSERT INTO projects (id, name, api_key_hash, team_id, created_at) VALUES (?,?,?,?,?)",
                     (pid, name, db.hash_api_key(key), g.user["team_id"], db.now()))
    # The one and only time the plaintext key leaves the server.
    return jsonify(id=pid, name=name, apiKey=key), 201


# ── storage / retention ─────────────────────────────────────────────────────

@bp.get("/api/storage")
@require_user
def storage():
    from . import retention
    clip_days, full_days = retention.retain_days()
    return jsonify(bytes=retention.usage_bytes(_team_project_ids()), clip_days=clip_days, retain_days=full_days)


def _team_project_ids():
    with db.connect() as conn:
        return [r["id"] for r in conn.execute("SELECT id FROM projects WHERE team_id = ?", (g.user["team_id"],)).fetchall()]


@bp.post("/api/storage/cleanup")
@require_user
def storage_cleanup():
    if g.user["role"] != "admin":
        return jsonify(error="admin only"), 403
    from . import retention
    out = retention.purge()                  # same retention rules for every team; only expired files go
    out["bytes"] = retention.usage_bytes(_team_project_ids())
    return jsonify(out)


@bp.post("/api/projects/<pid>/rotate-key")
@require_user
def rotate_key(pid):
    if g.user["role"] != "admin":
        return jsonify(error="admin only"), 403
    key = db.make_api_key()
    with db.connect() as conn:
        changed = conn.execute("UPDATE projects SET api_key_hash = ? WHERE id = ? AND team_id = ?",
                               (db.hash_api_key(key), pid, g.user["team_id"])).rowcount
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

    q = """SELECT i.id, i.title, i.description, i.test_case, i.severity, i.status, i.fixed_in_build,
                  i.build_version, i.game, i.session, i.platform, i.device_model, i.os_version,
                  i.has_screenshot, i.has_logs, i.has_clip, i.created_at, i.updated_at, u.email AS assignee
           FROM issues i LEFT JOIN users u ON u.id = i.assignee_id WHERE i.project_id = ?"""
    params: list = [project["id"]]
    if request.args.get("status"):
        q += " AND i.status = ?"; params.append(request.args["status"])
    if request.args.get("game"):
        q += " AND i.game = ?"; params.append(request.args["game"])
    if request.args.get("since"):
        try:
            params.append(int(request.args["since"])); q += " AND i.created_at >= ?"
        except (TypeError, ValueError):
            return jsonify(error="`since` must be a unix timestamp"), 400
    if request.args.get("with_test_case"):
        q += " AND i.test_case IS NOT NULL AND i.test_case <> ''"
    q += " ORDER BY i.created_at DESC LIMIT 2000"

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
    if not _own_project(pid):
        return jsonify(error="not found"), 404
    q = """SELECT i.id, i.title, i.severity, i.status, i.fixed_in_build, i.build_version, i.game, i.session,
                  i.platform, i.has_screenshot, i.created_at, i.assignee_id, u.email AS assignee_email
           FROM issues i LEFT JOIN users u ON u.id = i.assignee_id
           WHERE i.project_id = ?"""
    params: list = [pid]
    if request.args.get("build"):
        q += " AND i.build_version = ?"; params.append(request.args["build"])
    if request.args.get("game"):
        q += " AND i.game = ?"; params.append(request.args["game"])
    if request.args.get("status"):
        q += " AND i.status = ?"; params.append(request.args["status"])
    q += " ORDER BY i.created_at DESC LIMIT 500"
    with db.connect() as conn:
        rows = conn.execute(q, params).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.get("/api/issues/<iid>")
@require_user
def issue_detail(iid):
    if not _own_issue(iid):
        return jsonify(error="not found"), 404
    with db.connect() as conn:
        row = conn.execute(
            "SELECT i.*, u.email AS assignee_email FROM issues i LEFT JOIN users u ON u.id = i.assignee_id WHERE i.id = ?",
            (iid,),
        ).fetchone()
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
    if not _own_issue(iid):
        return jsonify(error="not found"), 404
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


@bp.patch("/api/issues/<iid>/assignee")
@require_user
def set_assignee(iid):
    """Assign an issue to a member of the signed-in user's team, or clear it with null."""
    if not _own_issue(iid):
        return jsonify(error="not found"), 404
    uid = (request.get_json(silent=True) or {}).get("assignee_id")
    with db.connect() as conn:
        if uid:
            member = conn.execute("SELECT email FROM users WHERE id = ? AND team_id = ?",
                                  (str(uid), g.user["team_id"])).fetchone()
            if member is None:
                return jsonify(error="that person is not in your team"), 400
        if conn.execute("SELECT 1 FROM issues WHERE id = ?", (iid,)).fetchone() is None:
            return jsonify(error="not found"), 404
        conn.execute("UPDATE issues SET assignee_id = ?, updated_at = ? WHERE id = ?",
                     (str(uid) if uid else None, db.now(), iid))
    return jsonify(ok=True, assignee_id=str(uid) if uid else None, assignee_email=member["email"] if uid else None)


@bp.patch("/api/issues/<iid>/notes")
@require_user
def set_notes(iid):
    if not _own_issue(iid):
        return jsonify(error="not found"), 404
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
    if not _own_issue(iid):
        return jsonify(error="not found"), 404
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
    if not _own_issue(iid):
        return jsonify(error="not found"), 404
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
    if pid is None or not _own_project(pid):
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
    if not _own_issue(iid):
        return jsonify(error="not found"), 404
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
    return os.path.join(UPLOAD_ROOT, pid, iid, "clip") if pid and _own_project(pid) else None


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
    if not _own_project(pid):
        return jsonify(error="not found"), 404
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
    if not _own_project(pid):
        return jsonify(error="not found"), 404
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
