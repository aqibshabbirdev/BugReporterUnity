"""Mini admin panel: how many multiplayer matches were played per day.

  POST /api/stats/match   X-Api-Key (the project's key, like /api/report); body {transaction_id, game_id, build}.
                          Both players of a match report it; the challenge id makes it count once.
  GET  /api/stats/daily   dashboard login; ?days=30 → per day (Pakistan time) totals and per-game counts.
  GET  /stats             the panel page (sign in on the dashboard first).
"""
import time

from flask import Blueprint, g, jsonify, request

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


@bp.post("/api/stats/match")
def report_match():
    api_key = request.headers.get("X-Api-Key", "")
    if not api_key.startswith("br_"):
        return jsonify(error="missing or malformed X-Api-Key"), 401
    key_hash = db.hash_api_key(api_key)
    with db.connect() as conn:
        project = conn.execute("SELECT id FROM projects WHERE api_key_hash = ?", (key_hash,)).fetchone()
    if project is None:
        return jsonify(error="unknown api key"), 401
    if _rate_limited(key_hash):
        return jsonify(error="rate limited"), 429

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
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:20px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.tile .k { color:var(--muted); font-size:13px; }
.tile .v { font-size:28px; font-weight:650; font-variant-numeric:tabular-nums; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
th, td { text-align:left; padding:9px 12px; border-top:1px solid var(--line); vertical-align:top; }
th { border-top:0; color:var(--muted); font-weight:600; font-size:13px; }
td.n { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
.bar { height:6px; background:var(--bar); border-radius:3px; margin-top:4px; min-width:2px; }
.games { color:var(--muted); font-size:13px; }
.msg { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }
a { color:var(--accent); }
h2 { font-size:16px; margin:28px 0 10px; }
</style></head><body><main>
<header><h1>Multiplayer matches per day</h1>
<select id="days"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select></header>
<div id="out"><div class="msg">Loading…</div></div>
<p class="games">Counted once per challenge when a player connects to its match server. Days in Pakistan time.</p>
</main>
<script>
const out = document.getElementById('out'), sel = document.getElementById('days');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load() {
  const r = await fetch('/api/stats/daily?days=' + sel.value, {credentials: 'same-origin'});
  if (r.status === 401) { out.innerHTML = '<div class="msg">Please <a href="/">sign in to the dashboard</a> first, then open this page again.</div>'; return; }
  if (!r.ok) { out.innerHTML = '<div class="msg">Could not load stats (' + r.status + ').</div>'; return; }
  const data = await r.json();
  if (!data.projects.length) { out.innerHTML = '<div class="msg">No projects in your team.</div>'; return; }
  out.innerHTML = data.projects.map(p => {
    const d = p.days, total = d.reduce((a, x) => a + x.total, 0), max = Math.max(1, ...d.map(x => x.total));
    const rows = d.map(x => '<tr><td>' + x.date + '</td><td class="n">' + x.total +
      (x.total ? '<div class="bar" style="width:' + (x.total / max * 100) + '%"></div>' : '') + '</td><td class="games">' +
      Object.entries(x.games).sort((a, b) => b[1] - a[1]).map(([g, n]) => esc(g) + ' ' + n).join(' · ') + '</td></tr>').join('');
    return (data.projects.length > 1 ? '<h2>' + esc(p.project) + '</h2>' : '') +
      '<div class="tiles"><div class="tile"><div class="k">Today</div><div class="v">' + d[0].total + '</div></div>' +
      '<div class="tile"><div class="k">Yesterday</div><div class="v">' + (d[1] ? d[1].total : 0) + '</div></div>' +
      '<div class="tile"><div class="k">Last ' + d.length + ' days</div><div class="v">' + total + '</div></div></div>' +
      '<table><thead><tr><th>Date</th><th>Matches</th><th>By game</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }).join('');
}
sel.onchange = load; load();
</script></body></html>"""
