"""Mini admin panel: how many multiplayer matches were played per day.

  POST /api/stats/match   X-Api-Key (the project's key, like /api/report); body {transaction_id, game_id, build}.
                          Both players of a match report it; the challenge id makes it count once.
  POST /api/stats/match-log  X-Api-Key; the match server's event log of one match, sent with the result:
                          {transaction_id, game_id, winner_name, reason, scores, events: [{t, time, msg}]}.
                          Stored as sent (re-sending replaces it) and counted as a played match too.
  GET  /api/stats/daily   dashboard login; ?days=30 → per day (Pakistan time) totals and per-game counts.
  GET  /api/stats/matches dashboard login; ?date=YYYY-MM-DD → that day's matches that have a log.
  GET  /api/stats/match-log/<transaction_id>  dashboard login; the stored JSON.
  GET  /stats             the panel page (sign in on the dashboard first).
"""
import calendar
import json
import time

from flask import Blueprint, Response, g, jsonify, request

from . import db
from .api import require_user

bp = Blueprint("stats", __name__)

DAY_OFFSET = 5 * 3600          # days are counted in Pakistan time (UTC+5)
RATE_LIMIT, RATE_WINDOW = 600, 60.0   # per key — every player shares the project key
_recent: dict[str, list[float]] = {}

# Lobby game ids (Unity GameDownloads / GameSceneRouter). Unknown ids show as "Game <id>".
GAME_NAMES = {
    1: "8 Ball Pool", 2: "Ludo", 3: "Teen Patti", 4: "Carrom", 5: "Roulette", 6: "Snake & Ladder",
    7: "12 Beads", 8: "Poker", 9: "Big Wheel", 10: "Starburst", 11: "Car Race", 13: "Cricket",
    14: "Highway Racer", 15: "Snooker", 16: "Horse Riding", 17: "Coin Flip",
}


def _rate_limited(key_hash: str) -> bool:
    cutoff = time.time() - RATE_WINDOW
    stamps = [t for t in _recent.get(key_hash, []) if t > cutoff]
    limited = len(stamps) >= RATE_LIMIT
    if not limited:
        stamps.append(time.time())
    _recent[key_hash] = stamps
    return limited


MAX_LOG_BYTES = 512 * 1024


def _project_from_key():
    """(project row, None) or (None, error response) for the X-Api-Key of this request."""
    api_key = request.headers.get("X-Api-Key", "")
    if not api_key.startswith("br_"):
        return None, (jsonify(error="missing or malformed X-Api-Key"), 401)
    key_hash = db.hash_api_key(api_key)
    with db.connect() as conn:
        project = conn.execute("SELECT id FROM projects WHERE api_key_hash = ?", (key_hash,)).fetchone()
    if project is None:
        return None, (jsonify(error="unknown api key"), 401)
    if _rate_limited(key_hash):
        return None, (jsonify(error="rate limited"), 429)
    return project, None


def _game_name(game_id) -> str:
    try:
        gid = int(game_id or 0)
    except (TypeError, ValueError):
        gid = 0
    return GAME_NAMES.get(gid, f"Game {gid}")


@bp.post("/api/stats/match-log")
def report_match_log():
    project, err = _project_from_key()
    if err:
        return err
    if request.content_length and request.content_length > MAX_LOG_BYTES:
        return jsonify(error="log too large"), 413
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="json body required"), 400
    tx = str(body.get("transaction_id") or "").strip()[:80]
    if not tx:
        return jsonify(error="transaction_id required"), 400
    try:
        game_id = int(body.get("game_id") or 0)
    except (TypeError, ValueError):
        game_id = 0
    events = body.get("events") if isinstance(body.get("events"), list) else []
    winner = str(body.get("winner_name") or body.get("winner_id") or "")[:120] or None
    raw = json.dumps(body, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_LOG_BYTES:
        return jsonify(error="log too large"), 413
    now = db.now()
    with db.connect() as conn:
        conn.execute("DELETE FROM match_logs WHERE project_id = ? AND transaction_id = ?", (project["id"], tx))
        conn.execute("INSERT INTO match_logs (project_id, transaction_id, game_id, winner, event_count, body, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)", (project["id"], tx, game_id, winner, len(events), raw, now))
        conn.execute("INSERT IGNORE INTO match_sessions (project_id, transaction_id, game_id, build, created_at) "
                     "VALUES (?, ?, ?, ?, ?)", (project["id"], tx, game_id, None, now))
    return jsonify(ok=True)


def _team_project_ids(conn):
    return [r["id"] for r in conn.execute("SELECT id FROM projects WHERE team_id = ?", (g.user["team_id"],)).fetchall()]


@bp.get("/api/stats/matches")
@require_user
def matches_of_day():
    date = request.args.get("date", "")
    try:
        day = calendar.timegm(time.strptime(date, "%Y-%m-%d")) // 86400   # the date's day number
    except (ValueError, OverflowError):
        return jsonify(error="date must be YYYY-MM-DD"), 400
    start = day * 86400 - DAY_OFFSET
    with db.connect() as conn:
        ids = _team_project_ids(conn)
        if not ids:
            return jsonify(matches=[])
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT transaction_id, game_id, winner, event_count, created_at FROM match_logs "
            f"WHERE project_id IN ({marks}) AND created_at >= ? AND created_at < ? ORDER BY created_at DESC",
            (*ids, start, start + 86400)).fetchall()
    return jsonify(matches=[{"transaction_id": r["transaction_id"], "game": _game_name(r["game_id"]),
                             "winner": r["winner"], "events": int(r["event_count"]),
                             "time": time.strftime("%H:%M", time.gmtime(int(r["created_at"]) + DAY_OFFSET))}
                            for r in rows])


@bp.get("/api/stats/match-log/<tx>")
@require_user
def match_log(tx):
    with db.connect() as conn:
        ids = _team_project_ids(conn)
        if not ids:
            return jsonify(error="not found"), 404
        marks = ",".join("?" * len(ids))
        row = conn.execute(f"SELECT body FROM match_logs WHERE project_id IN ({marks}) AND transaction_id = ?",
                           (*ids, tx[:80])).fetchone()
    if row is None:
        return jsonify(error="not found"), 404
    resp = Response(row["body"], mimetype="application/json")
    if request.args.get("download"):
        resp.headers["Content-Disposition"] = f'attachment; filename="match-{tx[:40]}.json"'
    return resp


@bp.post("/api/stats/match")
def report_match():
    project, err = _project_from_key()
    if err:
        return err

    body = request.get_json(silent=True) or {}
    tx = str(body.get("transaction_id") or "").strip()[:80]
    if not tx:
        return jsonify(error="transaction_id required"), 400
    try:
        game_id = int(body.get("game_id") or 0)
    except (TypeError, ValueError):
        game_id = 0
    build = str(body.get("build") or "")[:50] or None
    with db.connect() as conn:
        conn.execute("INSERT IGNORE INTO match_sessions (project_id, transaction_id, game_id, build, created_at) "
                     "VALUES (?, ?, ?, ?, ?)", (project["id"], tx, game_id, build, db.now()))
    return jsonify(ok=True)


@bp.get("/api/stats/daily")
@require_user
def daily():
    try:
        days = max(1, min(366, int(request.args.get("days", 30))))
    except ValueError:
        days = 30
    today = (int(time.time()) + DAY_OFFSET) // 86400
    since = (today - days + 1) * 86400 - DAY_OFFSET
    with db.connect() as conn:
        projects = conn.execute("SELECT id, name FROM projects WHERE team_id = ? ORDER BY created_at",
                                (g.user["team_id"],)).fetchall()
        out = []
        for p in projects:
            rows = conn.execute(
                "SELECT FLOOR((created_at + ?) / 86400) AS d, game_id, COUNT(*) AS n FROM match_sessions "
                "WHERE project_id = ? AND created_at >= ? GROUP BY d, game_id",
                (DAY_OFFSET, p["id"], since)).fetchall()
            per_day = {}
            for r in rows:
                day = per_day.setdefault(int(r["d"]), {"total": 0, "games": {}})
                name = GAME_NAMES.get(int(r["game_id"]), f"Game {r['game_id']}")
                day["games"][name] = day["games"].get(name, 0) + int(r["n"])
                day["total"] += int(r["n"])
            series = []
            for d in range(today, today - days, -1):
                v = per_day.get(d, {"total": 0, "games": {}})
                series.append({"date": time.strftime("%Y-%m-%d", time.gmtime(d * 86400)),
                               "total": v["total"], "games": v["games"]})
            out.append({"project": p["name"], "days": series})
    return jsonify(projects=out)


@bp.get("/stats")
@bp.get("/stats/")
def page():
    return PAGE, 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Match Stats</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5d6470; --line:#e3e6ea; --accent:#2457d6; --bar:#2457d6; }
@media (prefers-color-scheme: dark) { :root { --bg:#111317; --card:#1b1e24; --text:#eceef2; --muted:#9aa1ad; --line:#2a2e36; --accent:#6f9bff; --bar:#6f9bff; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
main { max-width:900px; margin:0 auto; padding:28px 16px 48px; }
header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
h1 { font-size:20px; margin:0; }
select { font:inherit; padding:6px 10px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--text); }
.panel { background:var(--card); border:1px solid var(--line); border-radius:6px; box-shadow:0 2px 6px rgba(0,0,0,.12); margin-bottom:20px; }
.panel-h { display:flex; align-items:center; gap:8px; padding:12px 16px; border-bottom:1px solid var(--line); font-weight:650; color:var(--muted); }
.panel-h svg { width:16px; height:16px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; padding:12px; }
.tile { color:#fff; border-radius:6px; padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:76px; }
.tile svg { width:40px; height:40px; flex:none; fill:#fff; }
.tile .num { text-align:right; min-width:0; }
.tile .v { font-size:30px; line-height:1.1; font-variant-numeric:tabular-nums; }
.tile .k { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.c1 { background:#3d88cc; } .c2 { background:#5cb85c; } .c3 { background:#f0ad4e; } .c4 { background:#d9534f; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
th, td { text-align:left; padding:9px 12px; border-top:1px solid var(--line); vertical-align:top; }
th { border-top:0; color:var(--muted); font-weight:600; font-size:13px; }
td:first-child { white-space:nowrap; }
td.n { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
.bar { height:6px; background:var(--bar); border-radius:3px; margin-top:4px; min-width:2px; }
.games { color:var(--muted); font-size:13px; }
.msg { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }
a { color:var(--accent); }
tr.day { cursor:pointer; }
tr.day:hover td { background:var(--bg); }
tr.detail td { background:var(--bg); padding:10px 12px 14px; }
.mlist { display:flex; flex-direction:column; gap:6px; }
.mrow { display:flex; gap:10px; align-items:center; flex-wrap:wrap; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; }
.mrow b { font-weight:600; }
.mrow .sp { flex:1; }
button.lnk, a.lnk { font:inherit; font-size:13px; background:none; border:1px solid var(--line); color:var(--accent); border-radius:6px; padding:3px 8px; cursor:pointer; }
.log { margin-top:8px; max-height:420px; overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
.log .t { color:var(--muted); }
h2 { font-size:16px; margin:28px 0 10px; }
</style></head><body><main>
<header><h1>Multiplayer matches per day</h1>
<select id="days"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select></header>
<div id="out"><div class="msg">Loading…</div></div>
<p class="games">Counted once per challenge when a player connects to its match server. Days in Pakistan time. Tap a day to see its matches and their server logs.</p>
</main>
<script>
const out = document.getElementById('out'), sel = document.getElementById('days');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const I = {
  today: '<svg viewBox="0 0 24 24"><path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm-2 7h14v11H5V9zm2 2v3h3v-3H7z"/></svg>',
  yday: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.4l4.2 2.5-1 1.7L11 13V7h2z"/></svg>',
  total: '<svg viewBox="0 0 24 24"><path d="M4 20h16v2H4v-2zm1-2V10h3v8H5zm5 0V4h3v14h-3zm5 0v-6h3v6h-3z"/></svg>',
  top: '<svg viewBox="0 0 24 24"><path d="M17 3V2H7v1H3v4a4 4 0 0 0 4 4h.3A5 5 0 0 0 11 14.9V18H8v3h8v-3h-3v-3.1A5 5 0 0 0 16.7 11h.3a4 4 0 0 0 4-4V3h-4zM5 7V5h2v4a2 2 0 0 1-2-2zm14 0a2 2 0 0 1-2 2V5h2v2z"/></svg>',
};
const CHART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20h18v2H3v-2zm2-2V9h3v9H5zm5 0V4h3v14h-3zm5 0v-7h3v7h-3z"/></svg>';
function tile(cls, icon, v, k) {
  return '<div class="tile ' + cls + '">' + I[icon] + '<div class="num"><div class="v">' + v + '</div><div class="k">' + k + '</div></div></div>';
}
function panel(d, total) {
  const games = {};
  d.forEach(x => Object.entries(x.games).forEach(([g, n]) => games[g] = (games[g] || 0) + n));
  const top = Object.entries(games).sort((a, b) => b[1] - a[1])[0];
  return '<div class="panel"><div class="panel-h">' + CHART + 'Match Stats</div><div class="tiles">' +
    tile('c1', 'today', d[0].total, 'Today') +
    tile('c2', 'yday', d[1] ? d[1].total : 0, 'Yesterday') +
    tile('c3', 'total', total, d.length + ' days') +
    tile('c4', 'top', top ? top[1] : 0, top ? esc(top[0]) : 'Top game') + '</div></div>';
}
async function load() {
  const r = await fetch('/api/stats/daily?days=' + sel.value, {credentials: 'same-origin'});
  if (r.status === 401) { out.innerHTML = '<div class="msg">Please <a href="/">sign in to the dashboard</a> first, then open this page again.</div>'; return; }
  if (!r.ok) { out.innerHTML = '<div class="msg">Could not load stats (' + r.status + ').</div>'; return; }
  const data = await r.json();
  if (!data.projects.length) { out.innerHTML = '<div class="msg">No projects in your team.</div>'; return; }
  out.innerHTML = data.projects.map(p => {
    const d = p.days, total = d.reduce((a, x) => a + x.total, 0), max = Math.max(1, ...d.map(x => x.total));
    const rows = d.map(x => '<tr class="day" data-date="' + x.date + '"><td>' + x.date + '</td><td class="n">' + x.total +
      (x.total ? '<div class="bar" style="width:' + (x.total / max * 100) + '%"></div>' : '') + '</td><td class="games">' +
      Object.entries(x.games).sort((a, b) => b[1] - a[1]).map(([g, n]) => esc(g) + ' ' + n).join(' · ') + '</td></tr>').join('');
    return (data.projects.length > 1 ? '<h2>' + esc(p.project) + '</h2>' : '') +
      panel(d, total) +
      '<table><thead><tr><th>Date</th><th>Matches</th><th>By game</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }).join('');
}
out.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-tx]');
  if (btn) { e.stopPropagation(); return showLog(btn); }
  const tr = e.target.closest('tr.day');
  if (!tr) return;
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  const row = document.createElement('tr'); row.className = 'detail';
  row.innerHTML = '<td colspan="3">Loading…</td>'; tr.after(row);
  const r = await fetch('/api/stats/matches?date=' + tr.dataset.date, {credentials: 'same-origin'});
  const data = r.ok ? await r.json() : {matches: []};
  row.firstChild.innerHTML = data.matches.length ? '<div class="mlist">' + data.matches.map(m =>
    '<div><div class="mrow"><b>' + esc(m.time) + '</b><span>' + esc(m.game) + '</span><span>Winner: ' + esc(m.winner || '–') +
    '</span><span class="sp"></span><span class="games">' + m.events + ' events</span>' +
    '<button class="lnk" data-tx="' + esc(m.transaction_id) + '">View log</button>' +
    '<a class="lnk" href="/api/stats/match-log/' + encodeURIComponent(m.transaction_id) + '?download=1">JSON</a></div></div>').join('') + '</div>'
    : '<span class="games">No server logs for this day.</span>';
});
async function showLog(btn) {
  const box = btn.closest('.mrow').parentElement;
  const open = box.querySelector('.log');
  if (open) { open.remove(); return; }
  const r = await fetch('/api/stats/match-log/' + encodeURIComponent(btn.dataset.tx), {credentials: 'same-origin'});
  const div = document.createElement('div'); div.className = 'log';
  if (!r.ok) { div.textContent = 'Could not load (' + r.status + ')'; box.append(div); return; }
  const j = await r.json();
  const head = [j.game ? j.game : '', j.reason ? 'Result: ' + j.reason : '', j.scores ? 'Score: ' + j.scores : '']
    .filter(Boolean).map(esc).join('\\n');
  div.innerHTML = (head ? head + '\\n\\n' : '') + (j.events || []).map(ev =>
    '<span class="t">' + esc(typeof ev.t === 'number' ? ev.t.toFixed(1).padStart(7) + 's' : '') + '</span>  ' + esc(ev.msg)).join('\\n');
  box.append(div);
}
sel.onchange = load; load();
</script></body></html>"""
