"""The /api/report endpoint the Unity SDK posts to.

Multipart form:
  report      application/json  (title, severity, buildVersion, device fields, metadata)
  logs        text/plain        (optional)
  screenshot  image/jpeg        (optional)
Header:
  X-Api-Key   the project's write-only key

Design: this is the only unauthenticated-ish write path in the app, so it is defensive —
key hash lookup, per-key rate limit, size caps, and it never trusts client filenames.
"""
import json
import os
import time

from flask import Blueprint, current_app, jsonify, request

from . import db

bp = Blueprint("ingest", __name__)

UPLOAD_ROOT = os.environ.get("BR_UPLOAD_DIR", "/data/uploads")
MAX_LOG_BYTES = 512 * 1024          # 200 lines should be ~30KB; half a MB is generous
MAX_SHOT_BYTES = 2 * 1024 * 1024    # jpeg q60 of a 1440p frame stays well under this

# Naive in-process rate limit: {key_hash: [timestamps]}. Fine for a single-instance MVP;
# revisit if Wasmer ever runs multiple replicas.
_recent: dict[str, list[float]] = {}
RATE_LIMIT = 30          # reports
RATE_WINDOW = 60.0       # per minute per key


def _rate_limited(key_hash: str) -> bool:
    cutoff = time.time() - RATE_WINDOW
    stamps = [t for t in _recent.get(key_hash, []) if t > cutoff]
    if len(stamps) >= RATE_LIMIT:
        _recent[key_hash] = stamps
        return True
    stamps.append(time.time())
    _recent[key_hash] = stamps
    return False


@bp.post("/api/report")
def report():
    api_key = request.headers.get("X-Api-Key", "")
    if not api_key.startswith("br_"):
        return jsonify(error="missing or malformed X-Api-Key"), 401

    key_hash = db.hash_api_key(api_key)
    with db.connect() as conn:
        project = conn.execute(
            "SELECT id FROM projects WHERE api_key_hash = ?", (key_hash,)
        ).fetchone()
    if project is None:
        return jsonify(error="unknown api key"), 401
    if _rate_limited(key_hash):
        return jsonify(error="rate limited"), 429

    raw = request.form.get("report")
    if not raw:
        return jsonify(error="missing report part"), 400
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        return jsonify(error="report part is not valid JSON"), 400

    title = str(body.get("title") or "").strip()[:200]
    if not title:
        return jsonify(error="title required"), 400
    build_version = str(body.get("buildVersion") or "unknown")[:50]
    severity = body.get("severity")
    if severity not in ("low", "normal", "high", "crash"):
        severity = "normal"

    logs = request.files.get("logs")
    shot = request.files.get("screenshot")

    issue_id = db.new_id()
    issue_dir = os.path.join(UPLOAD_ROOT, project["id"], issue_id)
    has_logs = has_shot = 0
    os.makedirs(issue_dir, exist_ok=True)

    if logs is not None:
        data = logs.read(MAX_LOG_BYTES + 1)
        if len(data) <= MAX_LOG_BYTES:
            with open(os.path.join(issue_dir, "logs.txt"), "wb") as f:
                f.write(data)
            has_logs = 1
    if shot is not None:
        data = shot.read(MAX_SHOT_BYTES + 1)
        # JPEG magic check — we serve these back to browsers, so never store an unvalidated blob as an image.
        if len(data) <= MAX_SHOT_BYTES and data[:3] == b"\xff\xd8\xff":
            with open(os.path.join(issue_dir, "screenshot.jpg"), "wb") as f:
                f.write(data)
            has_shot = 1

    ts = db.now()
    metadata = body.get("metadata")
    metadata_json = json.dumps(metadata)[:8192] if isinstance(metadata, dict) else "{}"
    platform = str(body.get("platform") or "")[:40]

    with db.connect() as conn:
        conn.execute(
            """INSERT INTO issues (id, project_id, title, description, severity, status,
                   build_version, platform, device_model, os_version, screen_resolution,
                   memory_mb, metadata, has_screenshot, has_logs, created_at, updated_at)
               VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?)""",
            (
                issue_id, project["id"], title,
                str(body.get("description") or "")[:2000],
                severity, build_version, platform,
                str(body.get("deviceModel") or "")[:80],
                str(body.get("osVersion") or "")[:80],
                str(body.get("screenResolution") or "")[:20],
                int(body.get("memoryMB") or 0),
                metadata_json, has_shot, has_logs, ts, ts,
            ),
        )
        # Build registry: first report from an unseen version creates the row (MySQL upsert).
        conn.execute(
            """INSERT INTO builds (id, project_id, version, platform, first_seen_at, report_count)
               VALUES (?,?,?,?,?,1)
               ON DUPLICATE KEY UPDATE report_count = report_count + 1""",
            (db.new_id(), project["id"], build_version, platform, ts),
        )

    current_app.logger.info("report %s accepted (build %s)", issue_id, build_version)
    return jsonify(id=issue_id), 201
