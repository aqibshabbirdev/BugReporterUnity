"""Edgegap match-server container logs, read from the S3 bucket Edgegap writes them to when a deployment ends.

Edgegap's layout: edgegap/arbitrium/<client>/<storage name>/<app>/<version>/container_log/<YYYY-MM-DD>/<file>
(NDJSON, one log line per JSON row). This module only reads: list a day's files and show one file.

  GET /api/stats/server-logs?date=YYYY-MM-DD&q=…   dashboard login or AI token; that day's log files
                                                   (q filters by file name, e.g. a deployment request id).
  GET /api/stats/server-logs/file?key=…&q=…        one file as lines {time, text}; q keeps lines containing it
                                                   (e.g. a transaction id, "[Snooker Flow]", "Exception").
  GET /api/stats/server-logs/for/<transaction_id>  the log of the match server that ran that match — by the
                                                   match log's request_id (ARBITRIUM_REQUEST_ID) when it has one,
                                                   else the first log saved after the match that mentions the id.
                                                   Shown by the "Server logs" button in /stats' match viewer.

Configuration (cPanel → Setup Python App → Environment variables; never in the repo):
  S3_LOGS_BUCKET, S3_LOGS_REGION (e.g. ap-southeast-2), S3_LOGS_KEY_ID, S3_LOGS_SECRET — a READ-ONLY key
  (s3:ListBucket + s3:GetObject on the bucket), not the key Edgegap writes with.
  Optional: S3_LOGS_STORAGE (Edgegap Endpoint Storage name, default "luckygames"), S3_LOGS_APP ("games-baba"),
  S3_LOGS_ENDPOINT (a non-AWS S3 host).
No AWS SDK: requests are signed here with Signature V4 (standard library only).
"""
import calendar
import datetime
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib

from flask import Blueprint, jsonify, request

from . import db
from .stats import _team_project_ids, require_stats_reader

bp = Blueprint("server_logs", __name__)

BASE = "edgegap/arbitrium/"
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_LINES = 5000
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
_cache = {"roots": None, "at": 0.0}


def _cfg():
    c = {"bucket": os.environ.get("S3_LOGS_BUCKET", ""), "region": os.environ.get("S3_LOGS_REGION", ""),
         "key": os.environ.get("S3_LOGS_KEY_ID", ""), "secret": os.environ.get("S3_LOGS_SECRET", ""),
         "storage": os.environ.get("S3_LOGS_STORAGE", "luckygames"), "app": os.environ.get("S3_LOGS_APP", "games-baba"),
         "endpoint": os.environ.get("S3_LOGS_ENDPOINT", "")}
    missing = [n for n, k in (("S3_LOGS_BUCKET", "bucket"), ("S3_LOGS_REGION", "region"), ("S3_LOGS_KEY_ID", "key"),
                              ("S3_LOGS_SECRET", "secret")) if not c[k]]
    return c, missing


def _q(s):
    return urllib.parse.quote(s, safe="-_.~")


def _get(c, path, query, first_bytes=None):
    """Signed GET (AWS Signature V4, virtual-hosted style). Returns the body bytes."""
    host = (urllib.parse.urlparse(c["endpoint"]).netloc if c["endpoint"]
            else f"{c['bucket']}.s3.{c['region']}.amazonaws.com")
    if c["endpoint"]:
        path = "/" + c["bucket"] + path          # custom endpoints: path style
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload = hashlib.sha256(b"").hexdigest()
    canon_uri = urllib.parse.quote(path, safe="/-_.~")
    canon_q = "&".join(f"{_q(k)}={_q(v)}" for k, v in sorted(query.items()))
    headers = {"host": host, "x-amz-content-sha256": payload, "x-amz-date": amz_date}
    signed = ";".join(sorted(headers))
    canon = "\n".join(["GET", canon_uri, canon_q, "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, payload])
    scope = f"{day}/{c['region']}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = ("AWS4" + c["secret"]).encode()
    for part in (day, c["region"], "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    extra = {"Range": f"bytes=0-{first_bytes - 1}"} if first_bytes else {}   # unsigned header, allowed
    req = urllib.request.Request(f"https://{host}{canon_uri}" + (f"?{canon_q}" if canon_q else ""), headers={**extra,
        "x-amz-content-sha256": payload, "x-amz-date": amz_date,
        "Authorization": f"AWS4-HMAC-SHA256 Credential={c['key']}/{scope}, SignedHeaders={signed}, Signature={sig}"})
    with urllib.request.urlopen(req, timeout=25) as r:
        # read(n) may return less than n before the end (one socket read), so loop until EOF or the cap
        chunks, size = [], 0
        while size <= MAX_FILE_BYTES:
            part = r.read(min(1024 * 1024, MAX_FILE_BYTES + 1 - size))
            if not part:
                break
            chunks.append(part)
            size += len(part)
        return b"".join(chunks)


def _list(c, prefix, delimiter=None, limit=2000):
    """(sub-prefixes, objects) under prefix; objects are {key, size, modified}."""
    prefixes, objects, token = [], [], None
    while True:
        q = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if delimiter: q["delimiter"] = delimiter
        if token: q["continuation-token"] = token
        root = ET.fromstring(_get(c, "/", q))
        prefixes += [p.findtext(_NS + "Prefix") for p in root.findall(_NS + "CommonPrefixes")]
        objects += [{"key": o.findtext(_NS + "Key"), "size": int(o.findtext(_NS + "Size") or 0),
                     "modified": o.findtext(_NS + "LastModified")} for o in root.findall(_NS + "Contents")]
        token = root.findtext(_NS + "NextContinuationToken")
        if not token or len(objects) >= limit:
            return prefixes, objects


def _version_roots(c):
    """Every edgegap/arbitrium/<client>/<storage>/<app>/<version>/ (cached 10 min)."""
    if _cache["roots"] is not None and time.time() - _cache["at"] < 600:
        return _cache["roots"]
    roots = []
    for client in _list(c, BASE, "/")[0]:
        roots += _list(c, f"{client}{c['storage']}/{c['app']}/", "/")[0]
    _cache.update(roots=roots, at=time.time())
    return roots


def _err(e):
    if isinstance(e, urllib.error.HTTPError):
        body = e.read(2000).decode("utf-8", "replace")
        code = (ET.fromstring(body).findtext("Code") if body.startswith("<") else None) or body[:200]
        return jsonify(error=f"S3 {e.code}: {code}"), 502
    return jsonify(error=f"S3: {type(e).__name__}: {e}"), 502


@bp.get("/api/stats/server-logs")
@require_stats_reader
def day_files():
    c, missing = _cfg()
    if missing:
        return jsonify(error="server logs not configured — set " + ", ".join(missing)), 503
    date = request.args.get("date", "")
    try:
        datetime.date.fromisoformat(date)
    except ValueError:
        return jsonify(error="date must be YYYY-MM-DD"), 400
    q = request.args.get("q", "").strip().lower()
    try:
        files = []
        for root in _version_roots(c):
            version = root.rstrip("/").rsplit("/", 1)[-1]
            for o in _list(c, f"{root}container_log/{date}/")[1]:
                name = o["key"].rsplit("/", 1)[-1]
                if q and q not in name.lower():
                    continue
                files.append(dict(o, name=name, version=version))
    except Exception as e:  # noqa: BLE001
        return _err(e)
    files.sort(key=lambda f: f["modified"] or "", reverse=True)
    return jsonify(date=date, files=files[:1000], truncated=len(files) > 1000)


def _line(row):
    """One NDJSON row → {time, text}; anything that is not JSON is shown as is."""
    try:
        d = json.loads(row)
    except ValueError:
        return {"time": "", "text": row}
    if not isinstance(d, dict):
        return {"time": "", "text": row}
    t = next((str(d[k]) for k in ("timestamp", "time", "ts", "@timestamp") if d.get(k)), "")
    text = next((d[k] for k in ("log", "message", "msg", "line", "text") if isinstance(d.get(k), str)), None)
    return {"time": t, "text": (text if text is not None else row).rstrip("\n")}


@bp.get("/api/stats/server-logs/file")
@require_stats_reader
def one_file():
    c, missing = _cfg()
    if missing:
        return jsonify(error="server logs not configured — set " + ", ".join(missing)), 503
    key = request.args.get("key", "")
    if not key.startswith(BASE) or "/container_log/" not in key or ".." in key:
        return jsonify(error="not a container log key"), 400
    try:
        raw = _get(c, "/" + key, {})
    except Exception as e:  # noqa: BLE001
        return _err(e)
    too_big = len(raw) > MAX_FILE_BYTES
    q = request.args.get("q", "").strip().lower()
    lines = [_line(r) for r in _text(raw).splitlines() if r.strip()]
    total = len(lines)
    if q:
        lines = [l for l in lines if q in l["text"].lower()]
    return jsonify(key=key, total_lines=total, lines=lines[-MAX_LINES:], cut=len(lines) > MAX_LINES or too_big)


def _read_lines(c, key):
    raw = _get(c, "/" + key, {})
    cut = len(raw) > MAX_FILE_BYTES
    return _text(raw), cut


def _text(raw):
    """Bytes → text; .gz is inflated as far as the bytes go (a cut file does not fail)."""
    if raw[:2] == b"\x1f\x8b":
        raw = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw, 64 * 1024 * 1024)
    return raw.decode("utf-8", "replace")


def _ts(iso):
    """UTC seconds from an ISO time like 2026-10-09T09:46:50.1427200Z (S3 and the match log both send UTC)."""
    try:
        return calendar.timegm(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return None


_found = {}   # transaction id → log key (a finished deployment's log never changes)


@bp.get("/api/stats/server-logs/for/<tx>")
@require_stats_reader
def for_match(tx):
    try:
        return _for_match(tx)
    except Exception as e:  # noqa: BLE001 — show the reason in the panel instead of a bare 500
        return jsonify(error=f"Server logs failed: {type(e).__name__}: {e}"), 502


def _for_match(tx):
    c, missing = _cfg()
    if missing:
        return jsonify(error="Server logs are not set up yet (missing " + ", ".join(missing) + ")."), 503
    tx = tx[:80]
    with db.connect() as conn:
        ids = _team_project_ids(conn)
        marks = ",".join("?" * len(ids)) or "''"
        row = conn.execute(f"SELECT body, created_at FROM match_logs WHERE project_id IN ({marks}) AND transaction_id = ?",
                           (*ids, tx)).fetchone() if ids else None
    if row is None:
        return jsonify(error="match not found"), 404
    try:
        b = json.loads(row["body"])
    except ValueError:
        b = {}
    rid = str(b.get("request_id") or "").strip().lower()
    end = _ts(b.get("ended_at")) or float(row["created_at"])
    try:
        key = _found.get(tx)
        text = cut = None
        if not key:
            # The log is saved when the deployment stops: the match's day or the next (UTC).
            days = sorted({datetime.datetime.fromtimestamp(end + d, datetime.timezone.utc).strftime("%Y-%m-%d") for d in (0, 86400)})
            files = []
            for root in _version_roots(c):
                for d in days:
                    files += _list(c, f"{root}container_log/{d}/")[1]
            if rid:
                key = next((f["key"] for f in files if rid in f["key"].lower()), None)
            else:
                # No request id (older server builds): the logs saved within 6 h after the match, nearest first,
                # and the first one that mentions the transaction id.
                near = []
                for f in files:
                    t = _ts(f["modified"])
                    if t is not None and end - 120 <= t <= end + 6 * 3600:
                        near.append((t - end, f["key"]))
                started = time.time()
                for _, k in sorted(near)[:15]:
                    if time.time() - started > 12:
                        break
                    if tx in _text(_get(c, "/" + k, {}, first_bytes=512 * 1024)):
                        key = k
                        break
            if not key:
                return jsonify(error="No server log found for this match yet. Edgegap saves it when the server "
                                     "stops" + (f" (request id {rid})." if rid else ".")), 404
            _found[tx] = key
        if text is None:
            text, cut = _read_lines(c, key)
    except Exception as e:  # noqa: BLE001
        return _err(e)
    lines = [_line(r) for r in text.splitlines() if r.strip()]
    return jsonify(key=key, name=key.rsplit("/", 1)[-1], request_id=rid or None, total_lines=len(lines),
                   lines=lines[-MAX_LINES:], cut=cut or len(lines) > MAX_LINES)
