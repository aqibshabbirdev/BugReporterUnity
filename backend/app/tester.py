"""API tester: the team's Postman collections, shared, at /apitestingbruno.

Collections and environments are stored as the Postman v2.1 JSON documents themselves. The page edits
those documents in place (unknown fields ride along untouched) and Export hands the same document back,
so a collection still opens in Postman after living here.

Saves are optimistic: every document has a version, a PUT names the version it was edited from, and a
stale one gets 409 instead of silently overwriting a teammate's change. The page then three-way merges
its edits onto the newer version (model.js M.merge3) and saves again — which is why every item carries a
stable `id` (_ensure_item_ids): the merge matches requests and folders across versions by it.

Test marks (tester_marks) are kept outside the documents: marking a request verified or not working is
one small write that doesn't bump the collection's version, so it never turns into a merge.

Same sign-in as the dashboard (the br_session cookie). Requests either go straight from the browser, or
through /api/tester/send — see tester_send.py for what the server refuses to reach.
"""
import json
import os
import time

from flask import Blueprint, abort, g, jsonify, request, send_from_directory

from . import db, tester_send
from .api import require_user

bp = Blueprint("tester", __name__)

PAGE = "/apitestingbruno"
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "tester_static"))
KINDS = ("collections", "environments")
MAX_DOC_BYTES = 8 * 1024 * 1024

SEND_LIMIT = 120              # sends per user per minute
_sends: dict[str, list[float]] = {}


# ── page ────────────────────────────────────────────────────────────────────

@bp.get(PAGE)
@bp.get(PAGE + "/")
def page():
    resp = send_from_directory(STATIC_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@bp.get(PAGE + "/static/<path:name>")
def static_asset(name):
    resp = send_from_directory(STATIC_DIR, name)
    resp.headers["Cache-Control"] = "no-cache"   # tiny files; always revalidate so a deploy shows at once
    return resp


# ── helpers ─────────────────────────────────────────────────────────────────

def _kind(kind):
    if kind not in KINDS:
        abort(404)
    return kind


def _mutating_guard():
    # Cookies are SameSite=Lax already; a custom header on writes also rules out any cross-site form post.
    if request.headers.get("X-Tester") != "1":
        abort(400, description="missing X-Tester header")


def _ensure_item_ids(data):
    """Give every folder/request a unique `id` (optional in the Postman v2.1 schema, so exports still
    open in Postman). A missing id gets one; a repeated id — a pasted copy — gets a fresh one.
    Returns True if anything changed."""
    seen, changed = set(), False
    stack = list(data.get("item") or [])
    while stack:
        it = stack.pop()
        if not isinstance(it, dict):
            continue
        iid = it.get("id")
        if not isinstance(iid, str) or not iid or iid in seen:
            it["id"] = db.new_id()
            changed = True
        seen.add(it["id"])
        if isinstance(it.get("item"), list):
            stack.extend(it["item"])
    return changed


def _all_items_have_ids(data):
    stack = list(data.get("item") or []) if isinstance(data, dict) else []
    while stack:
        it = stack.pop()
        if isinstance(it, dict):
            if not isinstance(it.get("id"), str) or not it["id"]:
                return False
            if isinstance(it.get("item"), list):
                stack.extend(it["item"])
    return True


def _validate(kind, data):
    if not isinstance(data, dict):
        return None, "document must be a JSON object"
    if kind == "collections":
        if not isinstance(data.get("item"), list):
            return None, "not a Postman collection (no item list)"
        _ensure_item_ids(data)
        info = data.setdefault("info", {})
        info.setdefault("schema", "https://schema.getpostman.com/json/collection/v2.1.0/collection.json")
        name = str(info.get("name") or "Untitled collection")
    else:
        if not isinstance(data.get("values"), list):
            return None, "not a Postman environment (no values list)"
        name = str(data.get("name") or "Untitled environment")
    text = json.dumps(data, ensure_ascii=False)
    if len(text.encode()) > MAX_DOC_BYTES:
        return None, "document is larger than 8 MB"
    return (name[:200], text), None


def _summary(row):
    return {"id": row["id"], "name": row["name"], "version": row["version"],
            "updatedAt": row["updated_at"], "updatedBy": row["updated_by"]}


# ── documents ───────────────────────────────────────────────────────────────

@bp.get("/api/tester/<kind>")
@require_user
def list_docs(kind):
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, name, version, updated_at, updated_by FROM tester_docs WHERE kind = ? ORDER BY name",
            (_kind(kind),),
        ).fetchall()
    return jsonify([_summary(r) for r in rows])


@bp.post("/api/tester/<kind>")
@require_user
def create_doc(kind):
    _mutating_guard()
    body = request.get_json(silent=True) or {}
    parsed, err = _validate(_kind(kind), body.get("data"))
    if err:
        return jsonify(error=err), 400
    name, text = parsed
    doc_id, ts = db.new_id(), db.now()
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO tester_docs (id, kind, name, data, version, created_at, updated_at, updated_by)
               VALUES (?,?,?,?,1,?,?,?)""",
            (doc_id, kind, name, text, ts, ts, g.user["email"]),
        )
    return jsonify(id=doc_id, name=name, version=1, updatedAt=ts, updatedBy=g.user["email"]), 201


@bp.get("/api/tester/<kind>/<doc_id>")
@require_user
def get_doc(kind, doc_id):
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, name, data, version, updated_at, updated_by FROM tester_docs WHERE kind = ? AND id = ?",
            (_kind(kind), doc_id),
        ).fetchone()
    if not row:
        return jsonify(error="not found"), 404
    data = json.loads(row["data"])
    if kind == "collections" and _ensure_item_ids(data):
        # A document stored before ids existed. Persist them as a new version (only if nobody saved in
        # between), then return what is stored, so every client merges against the same ids.
        with db.connect() as conn:
            conn.execute(
                "UPDATE tester_docs SET data = ?, version = version + 1 WHERE kind = ? AND id = ? AND version = ?",
                (json.dumps(data, ensure_ascii=False), kind, doc_id, row["version"]),
            )
            row = conn.execute(
                "SELECT id, name, data, version, updated_at, updated_by FROM tester_docs WHERE kind = ? AND id = ?",
                (kind, doc_id),
            ).fetchone()
        data = json.loads(row["data"])
    out = _summary(row)
    out["data"] = data
    return jsonify(out)


@bp.put("/api/tester/<kind>/<doc_id>")
@require_user
def save_doc(kind, doc_id):
    _mutating_guard()
    body = request.get_json(silent=True) or {}
    if kind == "collections" and not _all_items_have_ids(body.get("data")):
        # Only a page loaded before item ids existed sends this. Assigning fresh ids here would make
        # every other open page see all requests deleted and re-added, so ask for a reload instead.
        return jsonify(error="this page is out of date — reload it before saving "
                             "(Export the collection first if you have unsaved edits)"), 400
    parsed, err = _validate(_kind(kind), body.get("data"))
    if err:
        return jsonify(error=err), 400
    try:
        base_version = int(body.get("version"))
    except (TypeError, ValueError):
        return jsonify(error="version required"), 400
    name, text = parsed
    ts = db.now()
    with db.connect() as conn:
        cur = conn.execute(
            """UPDATE tester_docs SET name = ?, data = ?, version = version + 1, updated_at = ?, updated_by = ?
               WHERE kind = ? AND id = ? AND version = ?""",
            (name, text, ts, g.user["email"], kind, doc_id, base_version),
        )
        if cur.rowcount == 0:
            row = conn.execute(
                "SELECT version, updated_by FROM tester_docs WHERE kind = ? AND id = ?", (kind, doc_id)
            ).fetchone()
            if not row:
                return jsonify(error="not found"), 404
            return jsonify(error=f"{row['updated_by']} saved a newer version", version=row["version"],
                           updatedBy=row["updated_by"]), 409
    return jsonify(id=doc_id, name=name, version=base_version + 1, updatedAt=ts, updatedBy=g.user["email"])


@bp.delete("/api/tester/<kind>/<doc_id>")
@require_user
def delete_doc(kind, doc_id):
    _mutating_guard()
    if g.user["role"] != "admin":
        return jsonify(error="only an admin can delete a shared " + kind[:-1]), 403
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM tester_docs WHERE kind = ? AND id = ?", (_kind(kind), doc_id))
        if kind == "collections":
            conn.execute("DELETE FROM tester_marks WHERE collection_id = ?", (doc_id,))
    if cur.rowcount == 0:
        return jsonify(error="not found"), 404
    return jsonify(ok=True)


# ── test marks ──────────────────────────────────────────────────────────────

MARK_STATUSES = ("verified", "failing")     # "pending" = no row


def _mark_json(row):
    return {"status": row["status"], "note": row["note"], "responseCode": row["response_code"],
            "markedBy": row["marked_by"], "markedAt": row["marked_at"]}


@bp.get("/api/tester/collections/<coll_id>/marks")
@require_user
def list_marks(coll_id):
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT item_id, status, note, response_code, marked_by, marked_at
               FROM tester_marks WHERE collection_id = ?""", (coll_id,)
        ).fetchall()
    return jsonify({r["item_id"]: _mark_json(r) for r in rows})


@bp.put("/api/tester/collections/<coll_id>/marks/<item_id>")
@require_user
def set_mark(coll_id, item_id):
    _mutating_guard()
    body = request.get_json(silent=True) or {}
    status = body.get("status")
    if status != "pending" and status not in MARK_STATUSES:
        return jsonify(error="status must be pending, verified or failing"), 400
    if not item_id or len(item_id) > 64:
        return jsonify(error="invalid request id"), 400
    try:
        code = int(body["responseCode"]) if body.get("responseCode") is not None else None
    except (TypeError, ValueError):
        code = None
    note = str(body.get("note") or "")[:2000]
    ts = db.now()
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM tester_docs WHERE kind = 'collections' AND id = ?", (coll_id,)).fetchone():
            return jsonify(error="not found"), 404
        if status == "pending":
            conn.execute("DELETE FROM tester_marks WHERE collection_id = ? AND item_id = ?", (coll_id, item_id))
            return jsonify(status="pending")
        conn.execute(
            """INSERT INTO tester_marks (collection_id, item_id, status, note, response_code, marked_by, marked_at)
               VALUES (?,?,?,?,?,?,?)
               ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note),
                 response_code = VALUES(response_code), marked_by = VALUES(marked_by), marked_at = VALUES(marked_at)""",
            (coll_id, item_id, status, note, code, g.user["email"], ts),
        )
    return jsonify(status=status, note=note, responseCode=code, markedBy=g.user["email"], markedAt=ts)


# ── sending ─────────────────────────────────────────────────────────────────

@bp.post("/api/tester/send")
@require_user
def send():
    _mutating_guard()
    now = time.time()
    recent = [t for t in _sends.get(g.user["id"], []) if now - t < 60]
    if len(recent) >= SEND_LIMIT:
        return jsonify(error=f"slow down — {SEND_LIMIT} requests a minute"), 429
    recent.append(now)
    _sends[g.user["id"]] = recent

    req = request.get_json(silent=True) or {}
    try:
        result = tester_send.send(req.get("method"), req.get("url"), req.get("headers"), req.get("body"),
                                  verify_tls=req.get("verifyTls", True) is not False)
    except tester_send.Refused as e:
        return jsonify(error=str(e), refused=True), 400
    except tester_send.SendFailed as e:
        return jsonify(error=str(e)), 502
    return jsonify(result)
