"""Attachment retention.

The issue *row* is tiny (title, severity, status, comments) and is never deleted — only its heavy
evidence expires, in two tiers:

  clips (~3-6 MB each)  -> BR_RETAIN_CLIP_DAYS (default 7).  Biggest by far, and useless once a bug is
                           triaged, so they go first.
  screenshot/thumb/logs -> BR_RETAIN_DAYS (default 30).      Whole issue directory goes.

Without this the Wasmer /data volume fills and uploads start failing *silently* — nothing else in the
system prunes bytes. `has_screenshot`/`has_logs`/`has_clip` are cleared as files go, so the dashboard
already renders the "no attachment" states instead of broken images.
"""
import os
import shutil

from . import db

UPLOAD_ROOT = os.environ.get("BR_UPLOAD_DIR", "/data/uploads")


def _days(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def retain_days() -> tuple[int, int]:
    return _days("BR_RETAIN_CLIP_DAYS", 7), _days("BR_RETAIN_DAYS", 30)


def purge() -> dict:
    """Drop expired attachments. Safe to call often — the has_* flags mark what's already gone."""
    clip_days, full_days = retain_days()
    now = db.now()
    clip_cut = now - clip_days * 86400
    full_cut = now - full_days * 86400
    clips = full = 0

    with db.connect() as conn:
        # Tier 1 — clips only; the issue keeps its screenshot and logs.
        rows = conn.execute(
            "SELECT id, project_id FROM issues WHERE created_at < ? AND has_clip = 1", (clip_cut,)
        ).fetchall()
        for r in rows:
            shutil.rmtree(os.path.join(UPLOAD_ROOT, r["project_id"], r["id"], "clip"), ignore_errors=True)
        if rows:
            conn.execute("UPDATE issues SET has_clip = 0 WHERE created_at < ? AND has_clip = 1", (clip_cut,))
            clips = len(rows)

        # Tier 2 — everything else for old issues.
        rows = conn.execute(
            """SELECT id, project_id FROM issues
               WHERE created_at < ? AND (has_screenshot = 1 OR has_logs = 1 OR has_clip = 1)""",
            (full_cut,),
        ).fetchall()
        for r in rows:
            shutil.rmtree(os.path.join(UPLOAD_ROOT, r["project_id"], r["id"]), ignore_errors=True)
        if rows:
            conn.execute(
                """UPDATE issues SET has_screenshot = 0, has_logs = 0, has_clip = 0
                   WHERE created_at < ? AND (has_screenshot = 1 OR has_logs = 1 OR has_clip = 1)""",
                (full_cut,),
            )
            full = len(rows)

    return {"clips_purged": clips, "issues_purged": full,
            "clip_days": clip_days, "retain_days": full_days}


def usage_bytes() -> int:
    total = 0
    for root, _dirs, files in os.walk(UPLOAD_ROOT):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass          # raced with a purge — close enough for a usage figure
    return total
