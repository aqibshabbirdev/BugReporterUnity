"""Mini admin panel: how many multiplayer matches were played per day.

  POST /api/stats/match   X-Api-Key (the project's key, like /api/report); body {transaction_id, game_id, build}.
                          Both players of a match report it; the challenge id makes it count once.
  POST /api/stats/match-log  X-Api-Key; the match server's event log of one match, sent with the result:
                          {transaction_id, game_id, winner_name, reason, scores, events: [{t, time, msg}]}.
                          Stored as sent (re-sending replaces it) and counted as a played match too.
  POST /api/stats/flag    X-Api-Key; one flagged player from the match server:
                          {transaction_id, game, game_id, player_id, player_name, code, detail}.
  GET  /api/stats/flags   dashboard login; ?days=30 → players with flags (counts per code, games, last flag) plus
                          "pattern" flags worked out here (many wins because the opponent disconnected/left).
  GET  /api/stats/flags/<player_id>  dashboard login; that player's flags, newest first.
  GET  /api/stats/daily   dashboard login; ?days=30 → per day (Pakistan time) totals and per-game counts.
  GET  /api/stats/matches dashboard login; ?date=YYYY-MM-DD → that day's matches that have a log.
  GET  /api/stats/match-log/<transaction_id>  dashboard login; the stored JSON.
  GET  /stats             the panel page (sign in on the dashboard first).
"""
import calendar
import functools
import json
import os
import secrets
import time

from flask import Blueprint, Response, g, jsonify, request

from . import db
from .api import require_user

bp = Blueprint("stats", __name__)

AI_TOKEN_PREFIX = "brai_"
AI_TOKEN_TTL = 7 * 86400


def require_stats_reader(fn):
    """Dashboard login (cookie) or a read-only AI token (Authorization: Bearer brai_…) for the stats GET endpoints."""
    cookie_wrapped = require_user(fn)

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer " + AI_TOKEN_PREFIX):
            token = auth[len("Bearer "):].strip()
            with db.connect() as conn:
                row = conn.execute("SELECT user_id, team_id FROM ai_tokens WHERE token_hash = ? AND expires_at > ?",
                                   (db.hash_api_key(token), db.now())).fetchone()
            if row is None:
                return jsonify(error="AI token unknown or expired — copy a fresh prompt from /stats"), 401
            g.user = {"id": row["user_id"], "team_id": row["team_id"], "role": "ai-reader"}
            return fn(*args, **kwargs)
        return cookie_wrapped(*args, **kwargs)
    return wrapper

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
    ids = [r["id"] for r in conn.execute("SELECT id FROM projects WHERE team_id = ?", (g.user["team_id"],)).fetchall()]
    selected = request.args.get("project_id")
    return [i for i in ids if str(i) == selected] if selected else ids


def _game_filter():
    selected = request.args.get("game_id", "")
    if not selected:
        return ""
    try:
        return " AND game_id = " + str(int(selected))
    except ValueError:
        return " AND 1 = 0"



@bp.get("/api/stats/matches")
@require_stats_reader
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
            f"SELECT transaction_id, game_id, winner, event_count, created_at, body FROM match_logs "
            f"WHERE project_id IN ({marks}){_game_filter()} AND created_at >= ? AND created_at < ? ORDER BY created_at DESC",
            (*ids, start, start + 86400)).fetchall()
    out = []
    for r in rows:
        try:
            b = json.loads(r["body"])
        except ValueError:
            b = {}
        out.append({"transaction_id": r["transaction_id"], "game": _game_name(r["game_id"]),
                    "winner": r["winner"], "winner_id": b.get("winner_id"), "players": b.get("players") or [],
                    "events": int(r["event_count"]),
                    "time": time.strftime("%H:%M", time.gmtime(int(r["created_at"]) + DAY_OFFSET))})
    return jsonify(matches=out)


@bp.get("/api/stats/match-log/<tx>")
@require_stats_reader
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


@bp.post("/api/stats/flag")
def report_flag():
    project, err = _project_from_key()
    if err:
        return err
    b = request.get_json(silent=True)
    if not isinstance(b, dict):
        return jsonify(error="json body required"), 400
    player = str(b.get("player_id") or "").strip()[:80]
    code = str(b.get("code") or "").strip()[:60]
    if not player or not code:
        return jsonify(error="player_id and code required"), 400
    try:
        game_id = int(b.get("game_id") or 0)
    except (TypeError, ValueError):
        game_id = 0
    with db.connect() as conn:
        conn.execute("INSERT INTO match_flags (id, project_id, transaction_id, game_id, game, player_id, player_name, code, detail, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     (db.new_id(), project["id"], str(b.get("transaction_id") or "")[:80] or None, game_id,
                      str(b.get("game") or "")[:40] or None, player, str(b.get("player_name") or "")[:120] or None,
                      code, str(b.get("detail") or "")[:300] or None, db.now()))
    return jsonify(ok=True)


# Wins whose reason says the opponent dropped out; several in the period is worth a look (a player may be getting
# opponents to drop, or abusing the disconnect rule).
DISCONNECT_WIN_WORDS = ("disconnect", "left", "forfeit")
DISCONNECT_WIN_THRESHOLD = 3


def _since(days):
    today = (int(time.time()) + DAY_OFFSET) // 86400
    return (today - days + 1) * 86400 - DAY_OFFSET


# A pair is one-sided when the same two players met at least this often and one won at least this share.
PAIR_MIN_MATCHES = 5
PAIR_ONE_SIDED_SHARE = 0.8


def _log_seconds(b):
    ev = b.get("events") or []
    try:
        return float(ev[-1].get("t") or 0) if ev else None
    except (TypeError, ValueError, AttributeError):
        return None


def _pairs(conn, ids, since):
    """Head-to-head per pair of players from the match logs: matches, wins each, games, average length."""
    marks = ",".join("?" * len(ids))
    pairs = {}
    for r in conn.execute(f"SELECT transaction_id, body, created_at FROM match_logs WHERE project_id IN ({marks}){_game_filter()} AND created_at >= ?",
                          (*ids, since)).fetchall():
        try:
            b = json.loads(r["body"])
        except ValueError:
            continue
        ps = [p for p in (b.get("players") or []) if isinstance(p, dict) and p.get("id")]
        if len(ps) != 2:
            continue
        a, c = sorted(ps, key=lambda p: str(p["id"]))
        k = (str(a["id"]), str(c["id"]))
        e = pairs.setdefault(k, {"players": {k[0]: {"id": k[0], "name": a.get("name"), "wins": 0},
                                             k[1]: {"id": k[1], "name": c.get("name"), "wins": 0}},
                                 "matches": 0, "games": set(), "reasons": {}, "secs": [], "tx": [], "last_at": 0})
        e["matches"] += 1
        wid = str(b.get("winner_id") or "")
        if wid in e["players"]:
            e["players"][wid]["wins"] += 1
        if b.get("game"): e["games"].add(b.get("game"))
        reason = str(b.get("reason") or "?")
        e["reasons"][reason] = e["reasons"].get(reason, 0) + 1
        sec = _log_seconds(b)
        if sec is not None: e["secs"].append(sec)
        e["tx"].append(r["transaction_id"])
        e["last_at"] = max(e["last_at"], int(r["created_at"]))
    out = []
    for e in pairs.values():
        if e["matches"] < 2:
            continue
        w, l = sorted(e["players"].values(), key=lambda p: -p["wins"])
        out.append({"winner": w, "loser": l, "matches": e["matches"], "games": sorted(e["games"]), "reasons": e["reasons"],
                    "avg_seconds": round(sum(e["secs"]) / len(e["secs"])) if e["secs"] else None,
                    "one_sided": e["matches"] >= PAIR_MIN_MATCHES and w["wins"] >= PAIR_ONE_SIDED_SHARE * e["matches"],
                    "transaction_ids": e["tx"][-20:], "last_at": e["last_at"]})
    out.sort(key=lambda p: -p["matches"])
    return out


@bp.get("/api/stats/flags")
@require_stats_reader
def flagged_players():
    try:
        days = max(1, min(366, int(request.args.get("days", 30))))
    except ValueError:
        days = 30
    return jsonify(players=_flagged_players(days), disconnect_win_threshold=DISCONNECT_WIN_THRESHOLD)


def _flagged_players(days):
    since = _since(days)
    players = {}
    with db.connect() as conn:
        ids = _team_project_ids(conn)
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        for r in conn.execute(f"SELECT player_id, player_name, code, game, transaction_id, created_at FROM match_flags "
                              f"WHERE project_id IN ({marks}){_game_filter()} AND created_at >= ? ORDER BY created_at",
                              (*ids, since)).fetchall():
            p = players.setdefault(r["player_id"], {"player_id": r["player_id"], "name": r["player_name"], "count": 0,
                                                    "codes": {}, "games": set(), "matches": set(), "last_at": 0})
            p["name"] = r["player_name"] or p["name"]
            p["count"] += 1
            p["codes"][r["code"]] = p["codes"].get(r["code"], 0) + 1
            if r["game"]: p["games"].add(r["game"])
            if r["transaction_id"]: p["matches"].add(r["transaction_id"])
            p["last_at"] = max(p["last_at"], int(r["created_at"]))
        # Pattern: many wins by the opponent dropping out (from the match logs' winner and reason).
        wins = {}
        for r in conn.execute(f"SELECT transaction_id, body, created_at FROM match_logs WHERE project_id IN ({marks}){_game_filter()} AND created_at >= ?",
                              (*ids, since)).fetchall():
            try:
                b = json.loads(r["body"])
            except ValueError:
                continue
            reason = str(b.get("reason") or "").lower()
            wid = str(b.get("winner_id") or "")
            if not wid or wid == "draw" or not any(w in reason for w in DISCONNECT_WIN_WORDS):
                continue
            w = wins.setdefault(wid, {"name": b.get("winner_name"), "n": 0, "games": set(), "matches": set(), "last": 0,
                                      "list": []})
            w["n"] += 1
            if b.get("game"): w["games"].add(b.get("game"))
            w["matches"].add(r["transaction_id"])
            w["last"] = max(w["last"], int(r["created_at"]))
            opp = next((p_ for p_ in (b.get("players") or []) if str(p_.get("id")) != wid), {})
            w["list"].append({"transaction_id": r["transaction_id"], "game": b.get("game"), "reason": b.get("reason"),
                              "opponent_id": opp.get("id"), "opponent": opp.get("name")})
        for wid, w in wins.items():
            if w["n"] < DISCONNECT_WIN_THRESHOLD:
                continue
            p = players.setdefault(wid, {"player_id": wid, "name": w["name"], "count": 0, "codes": {}, "games": set(),
                                         "matches": set(), "last_at": 0})
            p["codes"]["many_disconnect_wins"] = w["n"]
            p["count"] += 1
            p["games"] |= w["games"]
            p["matches"] |= w["matches"]
            p["last_at"] = max(p["last_at"], w["last"])
            p.setdefault("evidence", {})["disconnect_wins"] = w["list"][:20]
        # Pattern: the same two players again and again, one side nearly always winning (collusion / chip dumping).
        for pair in _pairs(conn, ids, since):
            if not pair["one_sided"]:
                continue
            for side, other, role in ((pair["winner"], pair["loser"], "winner"), (pair["loser"], pair["winner"], "loser")):
                p = players.setdefault(side["id"], {"player_id": side["id"], "name": side["name"], "count": 0, "codes": {},
                                                    "games": set(), "matches": set(), "last_at": 0})
                p["codes"]["one_sided_pair"] = pair["matches"]
                p["count"] += 1
                p["games"] |= set(pair["games"])
                p["matches"] |= set(pair["transaction_ids"])
                p["last_at"] = max(p["last_at"], pair["last_at"])
                p.setdefault("evidence", {})["one_sided_pair"] = {
                    "role": role, "with_id": other["id"], "with": other["name"], "matches": pair["matches"],
                    "wins": side["wins"], "losses": other["wins"], "avg_seconds": pair["avg_seconds"]}
    out = [{"player_id": p["player_id"], "name": p["name"] or p["player_id"], "count": p["count"], "codes": p["codes"],
            "games": sorted(p["games"]), "matches": len(p["matches"]),
            "last": time.strftime("%Y-%m-%d %H:%M", time.gmtime(p["last_at"] + DAY_OFFSET)) if p["last_at"] else "",
            **({"evidence": p["evidence"]} if p.get("evidence") else {})}
           for p in players.values()]
    out.sort(key=lambda p: (-p["count"], p["name"] or ""))
    return out


@bp.get("/api/stats/flags/<player_id>")
@require_stats_reader
def player_flags(player_id):
    with db.connect() as conn:
        ids = _team_project_ids(conn)
        if not ids:
            return jsonify(flags=[])
        marks = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT game, code, detail, transaction_id, created_at FROM match_flags "
                            f"WHERE project_id IN ({marks}){_game_filter()} AND player_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200",
                            (*ids, player_id[:80], _since(max(1, min(366, request.args.get("days", 30, type=int) or 30))))).fetchall()
    return jsonify(flags=[{"game": r["game"], "code": r["code"], "detail": r["detail"], "transaction_id": r["transaction_id"],
                           "time": time.strftime("%Y-%m-%d %H:%M", time.gmtime(int(r["created_at"]) + DAY_OFFSET))}
                          for r in rows])


@bp.post("/api/stats/ai-token")
@require_user
def ai_token():
    """A read-only token (7 days) an AI assistant can use to read the stats endpoints — handed out inside the
    "Analyze with AI" prompt. It can read stats only: no dashboard, no writes."""
    token = AI_TOKEN_PREFIX + secrets.token_urlsafe(24)
    now = db.now()
    with db.connect() as conn:
        conn.execute("DELETE FROM ai_tokens WHERE expires_at < ?", (now,))
        conn.execute("INSERT INTO ai_tokens (token_hash, user_id, team_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                     (db.hash_api_key(token), g.user["id"], g.user["team_id"], now, now + AI_TOKEN_TTL))
    return jsonify(token=token, expires_in_days=AI_TOKEN_TTL // 86400)


FLAG_MEANINGS = {
    "false_win_claim": "claimed a win/finish the server's board does not back",
    "unbacked_win_claim": "claimed a win while the opponent was connected and the server had not ended the game",
    "out_of_turn": "acted on the opponent's turn",
    "illegal_move": "sent a move the rules do not allow",
    "roll_twice": "asked to roll again before moving",
    "move_without_roll": "asked to move without a roll",
    "replayed_action": "re-sent an already used action",
    "tampered_request": "sent a value the real app never sends (modified client)",
    "finish_too_far": "claimed the finish far from the line",
    "finish_missing_checkpoints": "claimed the finish without passing the checkpoints",
    "finish_before_start": "claimed the finish before the race started",
    "many_disconnect_wins": "won several matches because the opponent disconnected/left (pattern; evidence lists them)",
    "one_sided_pair": "played the same opponent many times and one side nearly always won — possible collusion / "
                      "chip dumping (pattern; evidence names the other player)",
    "fast_win_claim": "claimed a win unusually soon after the start (e.g. 8 ball potted seconds after the break)",
}


@bp.get("/api/stats/ai-export")
@require_stats_reader
def ai_export():
    """Everything an AI assistant needs for one review, compact: totals, per-day per-game counts, flagged players,
    recent flags and the logs of flagged matches (trimmed)."""
    try:
        days = max(1, min(90, int(request.args.get("days", 7))))
    except ValueError:
        days = 7
    since = _since(days)
    today = (int(time.time()) + DAY_OFFSET) // 86400
    with db.connect() as conn:
        ids = _team_project_ids(conn)
        if not ids:
            return jsonify(error="no projects"), 404
        marks = ",".join("?" * len(ids))
        per_day = {}
        for r in conn.execute(f"SELECT FLOOR((created_at + ?) / 86400) AS d, game_id, COUNT(*) AS n FROM match_sessions "
                              f"WHERE project_id IN ({marks}){_game_filter()} AND created_at >= ? GROUP BY d, game_id",
                              (DAY_OFFSET, *ids, since)).fetchall():
            day = per_day.setdefault(int(r["d"]), {})
            day[_game_name(r["game_id"])] = day.get(_game_name(r["game_id"]), 0) + int(r["n"])
        flags = [dict(r) for r in conn.execute(
            f"SELECT player_id, player_name, game, code, detail, transaction_id, created_at FROM match_flags "
            f"WHERE project_id IN ({marks}){_game_filter()} AND created_at >= ? ORDER BY created_at DESC LIMIT 300", (*ids, since)).fetchall()]
        flagged_tx = []
        for f in flags:
            if f["transaction_id"] and f["transaction_id"] not in flagged_tx:
                flagged_tx.append(f["transaction_id"])
        flagged_tx = flagged_tx[:20]
        logs = []
        if flagged_tx:
            tm = ",".join("?" * len(flagged_tx))
            for r in conn.execute(f"SELECT transaction_id, body FROM match_logs WHERE project_id IN ({marks}) "
                                  f"AND transaction_id IN ({tm})", (*ids, *flagged_tx)).fetchall():
                try:
                    b = json.loads(r["body"])
                except ValueError:
                    continue
                ev = b.get("events") or []
                logs.append({"transaction_id": r["transaction_id"], "game": b.get("game"), "players": b.get("players"),
                             "winner_id": b.get("winner_id"), "winner_name": b.get("winner_name"), "reason": b.get("reason"),
                             "scores": b.get("scores"), "flags": b.get("flags"),
                             "events": [e.get("msg") for e in (ev[:80] + ev[-40:] if len(ev) > 120 else ev)],
                             "events_total": len(ev)})
        results = {}
        for r in conn.execute(f"SELECT body FROM match_logs WHERE project_id IN ({marks}){_game_filter()} AND created_at >= ?",
                              (*ids, since)).fetchall():
            try:
                b = json.loads(r["body"])
            except ValueError:
                continue
            reason = str(b.get("reason") or "").lower()
            kind = "draw" if b.get("winner_id") == "draw" else \
                "opponent left/disconnected" if any(w in reason for w in DISCONNECT_WIN_WORDS) else \
                "time over" if "time" in reason else "played to the end"
            g_ = b.get("game") or "?"
            results.setdefault(g_, {}).setdefault(kind, 0)
            results[g_][kind] += 1
        pairs = [{"players": [{"id": p["winner"]["id"], "name": p["winner"]["name"], "wins": p["winner"]["wins"]},
                              {"id": p["loser"]["id"], "name": p["loser"]["name"], "wins": p["loser"]["wins"]}],
                  "matches": p["matches"], "games": p["games"], "reasons": p["reasons"],
                  "avg_seconds": p["avg_seconds"], "one_sided": p["one_sided"], "transaction_ids": p["transaction_ids"]}
                 for p in _pairs(conn, ids, since)[:30]]
    daily = []
    for d in range(today, today - days, -1):
        games = per_day.get(d, {})
        daily.append({"date": time.strftime("%Y-%m-%d", time.gmtime(d * 86400)), "total": sum(games.values()), "games": games})
    by_game = {}
    for d in daily:
        for k, v in d["games"].items():
            by_game[k] = by_game.get(k, 0) + v
    grouped = {}
    for f in flags:   # newest first: the first copy keeps the latest time
        t = time.strftime("%Y-%m-%d %H:%M", time.gmtime(int(f.pop("created_at")) + DAY_OFFSET))
        k = (f["player_id"], f["code"], f["transaction_id"], f["detail"])
        if k in grouped:
            grouped[k]["times"] += 1
        else:
            grouped[k] = dict(f, time=t, times=1)
    flags = list(grouped.values())
    with_log = {l["transaction_id"] for l in logs}
    return jsonify({
        "about": "Games Panda multiplayer stats from the match servers. Days in Pakistan time. A flag is a server-side "
                 "hint that a player did something the rules do not allow — a reason to review, not proof (a bad network "
                 "can cause the odd one). Results by type come only from matches whose server sent a log. times on a flag = "
                 "the same flag repeated in one match. head_to_head = pairs that met 2+ times (avg_seconds = average "
                 "match length from the log); one_sided marks 5+ meetings with one side winning 80%+.",
        "period_days": days,
        "totals": {"matches": sum(d["total"] for d in daily), "by_game": by_game},
        "daily": daily,
        "results_by_type": results,
        "flag_meanings": FLAG_MEANINGS,
        "flagged_players": _flagged_players(days),
        "recent_flags": flags,
        "flagged_match_logs": logs,
        "flagged_matches_without_log": [t for t in flagged_tx if t not in with_log],
        "head_to_head": pairs,
        "more": {"match_log": "/api/stats/match-log/<transaction_id>", "player_flags": "/api/stats/flags/<player_id>",
                 "matches_of_day": "/api/stats/matches?date=YYYY-MM-DD"},
    })


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
@require_stats_reader
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
        allowed = _team_project_ids(conn)
        for p in projects:
            if p["id"] not in allowed:
                continue
            rows = conn.execute(
                "SELECT FLOOR((created_at + ?) / 86400) AS d, game_id, COUNT(*) AS n FROM match_sessions "
                f"WHERE project_id = ?{_game_filter()} AND created_at >= ? GROUP BY d, game_id",
                (DAY_OFFSET, p["id"], (today - 2 * days) * 86400 - DAY_OFFSET)).fetchall()
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
            completed = sum(v["total"] for d, v in per_day.items() if today - days <= d < today)
            previous = sum(v["total"] for d, v in per_day.items() if today - 2 * days <= d < today - days)
            out.append({"project_id": p["id"], "project": p["name"], "days": series,
                        "comparison": {"days": days, "completed": completed, "previous": previous}})
    return jsonify(projects=out, sample_data=os.environ.get("BR_STATS_SAMPLE_DATA", "").lower() in ("1", "true"),
                   filters={"projects": [{"id": p["id"], "name": p["name"]} for p in projects],
                            "games": [{"id": k, "name": v} for k, v in GAME_NAMES.items()]})


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
table { width:100%; table-layout:fixed; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
th, td { text-align:left; padding:9px 12px; border-top:1px solid var(--line); vertical-align:top; }
th { border-top:0; color:var(--muted); font-weight:600; font-size:13px; }
tr.day td:first-child { white-space:nowrap; }
.viewer, .mlist { white-space:normal; }
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
.flags .flist { display:flex; flex-direction:column; }
.fp { border-top:1px solid var(--line); }
.fp:first-child { border-top:0; }
.fph { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 16px; cursor:pointer; font-size:14px; }
.fph:hover { background:var(--bg); }
.fcount { background:#d9534f; color:#fff; border-radius:10px; padding:1px 8px; font-size:12px; font-weight:600; }
.chip { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:1px 8px; font-size:12px; }
.fdetail { padding:0 16px 12px; }
.fempty, .fnote { padding:10px 16px; }
.fnote { border-top:1px solid var(--line); }
.mrow .sp { min-width:0; word-break:break-word; }
.uid { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:0 6px; color:var(--text); user-select:all; }
.nid { font:11px ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.9; margin-top:2px; word-break:break-all; user-select:all; }
.hright { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.aibtn { font:inherit; font-size:14px; border:0; border-radius:8px; padding:7px 12px; background:#6b4bd8; color:#fff; cursor:pointer; }
.aibox .aibody { padding:12px 16px; display:flex; flex-direction:column; gap:10px; }
.airow { display:flex; gap:10px; flex-wrap:wrap; align-items:end; font-size:13px; color:var(--muted); }
.airow label { display:flex; flex-direction:column; gap:4px; }
.airow input { font:inherit; padding:6px 8px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--text); }
#ai-prompt { width:100%; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; border:1px solid var(--line); border-radius:8px; padding:8px; background:var(--bg); color:var(--text); }
.viewer { margin-top:8px; }
dialog.viewer { position:fixed; inset:0 0 0 auto; margin:0; width:min(900px,95vw); max-width:95vw; height:100dvh; max-height:100dvh; overflow:auto; border:1px solid var(--line); background:var(--card); color:var(--text); padding:20px; }
dialog.viewer::backdrop { background:rgba(0,0,0,.55); }
@media(max-width:600px) { dialog.viewer { width:100vw; max-width:100vw; padding:12px; } }
.vbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px; }
.seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.seg button { font:inherit; font-size:13px; border:0; background:var(--card); color:var(--muted); padding:5px 12px; cursor:pointer; }
.seg button.on { background:var(--accent); color:#fff; }
pre.srv { white-space:pre-wrap; word-break:break-word; } .lt { color:var(--muted); } .le { color:#d9534f; } .lw { color:#c77c00; } .lf { color:#2e9e57; }
input.sq { font:inherit; padding:5px 9px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--text); flex:1; min-width:150px; }
pre.raw { margin:0; max-height:520px; overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
.flow { background:#1d2040; border-radius:12px; padding:14px 12px; max-height:640px; overflow:auto; display:flex; flex-direction:column; gap:14px; }
.frow { display:grid; grid-template-columns:minmax(110px,150px) 44px minmax(0,1fr); align-items:start; }
.node { --c:#8a8fa8; background:var(--c); color:#fff; border-radius:8px; padding:9px 10px; align-self:center; box-shadow:0 2px 8px rgba(0,0,0,.25); }
.node.start { --c:#11c58a; } .node.res { --c:#f5b301; color:#2a2100; }
.node.p0 { --c:#13b8d6; } .node.p1 { --c:#7c4dff; } .node.p2 { --c:#ff5c8a; } .node.p3 { --c:#ff8a00; }
.nt { font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:.02em; word-break:break-word; }
.ns { font-size:11px; opacity:.85; }
svg.links { width:44px; height:0; display:block; overflow:visible; }
.evs { display:flex; flex-direction:column; gap:5px; }
.ev { display:flex; gap:8px; align-items:baseline; border-radius:6px; padding:5px 8px; font-size:12.5px; color:#fff; background:#3a3f63; }
.ev .ek { font-size:10px; font-weight:700; text-transform:uppercase; opacity:.85; min-width:38px; }
.ev .em { flex:1; min-width:0; word-break:break-word; }
.ev .et { font-size:11px; opacity:.7; white-space:nowrap; }
.ev.shot { background:#2f62d9; } .ev.pot { background:#1e9e5a; } .ev.foul { background:#d64545; }
th:nth-child(1) { width:118px; } th:nth-child(2) { width:96px; }
@media (max-width:520px) {
  th:nth-child(1) { width:96px; } th:nth-child(2) { width:70px; }
  .frow { grid-template-columns:86px 26px minmax(0,1fr); }
  svg.links { width:26px; }
  .nt { font-size:11px; } .ev { font-size:11.5px; padding:4px 6px; gap:6px; } .ev .ek { display:none; }
  .flow { padding:10px 8px; }
}
.ev.score { background:#e09a1a; color:#241800; } .ev.turn { background:#55597d; } .ev.res { background:#f5b301; color:#2a2100; }
h2 { font-size:16px; margin:28px 0 10px; }
/* Analytics workspace */
main { max-width:1200px; }
header h1 { font-size:26px; }
.back { display:inline-block; margin-bottom:12px; text-decoration:none; }
.toolbar, .tabs { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
button, select { min-height:44px; }
button:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
.tabs button, .secondary { border:1px solid var(--line); border-radius:10px; padding:8px 16px; background:var(--card); color:var(--text); cursor:pointer; }
.tabs button[aria-pressed="true"] { background:var(--accent); color:white; }
[hidden] { display:none !important; }
.tile { background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:12px; }
.tile svg { fill:var(--accent); width:28px; height:28px; }
.panel { border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,.04); }
.day-action { font:inherit; border:0; background:transparent; color:var(--accent); cursor:pointer; text-align:left; padding:0; }
.chart { display:flex; gap:4px; align-items:flex-end; height:180px; padding:12px 16px 0; overflow-x:auto; }
.chart button { flex:1; min-width:16px; height:100%; display:flex; align-items:flex-end; padding:0; border:0; background:transparent; cursor:pointer; }
.chart span { display:block; width:100%; background:var(--accent); border-radius:4px 4px 0 0; min-height:3px; }
.chart-caption { padding:8px 16px 16px; display:flex; justify-content:space-between; font-size:13px; color:var(--muted); }
.fph { width:100%; border:0; background:transparent; color:var(--text); text-align:left; }
.fph .sp { flex:1; }
.fnote { background:var(--bg); border-bottom:1px solid var(--line); }
.mrow { padding:14px; gap:12px; }
.lnk { min-height:44px; display:inline-flex; align-items:center; }
.skeleton { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin:20px 0; }
.skeleton div { height:110px; background:var(--line); border-radius:12px; }
.copy-id { font:12px ui-monospace,monospace; border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:6px; padding:4px 8px; cursor:pointer; overflow-wrap:anywhere; }
.match-tools { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px; }
.match-tools input { flex:1; min-width:150px; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); }
.breakdown { display:flex; flex-wrap:wrap; gap:4px; }
.status { color:var(--muted); font-size:13px; }
@media(max-width:600px) { .tiles { grid-template-columns:repeat(2,minmax(0,1fr)); } .tile { padding:12px; } .tile svg { display:none; } .tile .num { text-align:left; } .tile .k { white-space:normal; } header h1 { font-size:22px; } .toolbar { gap:8px; } th,td { padding:8px; } .chart { height:140px; } .mrow { flex-direction:column; align-items:flex-start; } }
</style></head><body><main>
<a class="back" href="/">← Back to dashboard</a><header><h1>Match Analytics</h1><button id="ai-btn" class="aibtn">Copy AI analysis prompt</button></header>
<div class="toolbar"><label for="days">Period</label><select id="days"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select><label for="project-filter">Project</label><select id="project-filter"><option value="">All projects</option></select><label for="game-filter">Game</label><select id="game-filter"><option value="">All games</option></select><button id="refresh" class="secondary">Refresh</button><span class="status">PKT · UTC+5</span><span id="updated" class="status" role="status"></span></div>
<div class="tabs" aria-label="Analytics views"><button id="overview-tab" aria-pressed="true">Overview</button><button id="flags-tab" aria-pressed="false">Player flags</button></div>
<div id="ai-box" class="panel aibox" hidden><div class="panel-h">✦ Analyze with AI (Claude Code / Codex)</div><div class="aibody">
<p class="games">Copies a ready prompt with a <b>read-only</b> token (stats only, 7 days). Paste it into Claude Code or Codex — it reads the data and writes the review on your own subscription. No AI API is used.</p>
<div class="airow"><label>Period <select id="ai-days"><option value="1">Today</option><option value="7" selected>7 days</option><option value="30">30 days</option></select></label>
<label>Language <select id="ai-lang"><option>Roman Urdu</option><option>English</option></select></label>
<label>User ID (optional) <input id="ai-player" placeholder="focus on one player"></label>
<button id="ai-copy" class="aibtn">Copy prompt</button></div>
<div id="ai-status" class="games"></div><textarea id="ai-prompt" rows="10" hidden></textarea></div></div>
<p id="sample-banner" class="msg" hidden>Sample data — use this view for demonstration, not production decisions.</p><div id="out" aria-live="polite"><div class="msg">Loading analytics…</div></div><section id="flags-out" hidden aria-live="polite"></section>
<p class="games">Counted once per challenge when a player connects to its match server. Days in Pakistan time. Tap a day to see its matches and their server logs.</p>
</main>
<script>
const out = document.getElementById('out'), sel = document.getElementById('days');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function playerId(id) {
  const value = String(id || '');
  return '<button class="copy-id" data-copy-id="' + esc(value) + '" title="' + esc(value) + '" aria-label="Copy player ID ' + esc(value) + '">ID ' + esc(value.length > 16 ? value.slice(0,8) + '…' + value.slice(-4) : value) + '</button>';
}
document.addEventListener('click', async e => {
  const button = e.target.closest('[data-copy-id]'); if(!button) return;
  try { await navigator.clipboard.writeText(button.dataset.copyId); button.textContent = 'Copied'; }
  catch(e) { button.textContent = button.dataset.copyId; button.title = 'Select and copy this ID'; }
});
function gameBreakdown(games) {
  const values = Object.entries(games).sort((a,b) => b[1]-a[1]);
  const chip = ([g,n]) => '<span class="chip">' + esc(g) + ' ' + n + '</span>';
  return values.length ? '<div class="breakdown">' + values.slice(0,3).map(chip).join('') + '</div>' +
    (values.length > 3 ? '<details><summary>+' + (values.length-3) + ' more games</summary><div class="breakdown">' + values.slice(3).map(chip).join('') + '</div></details>' : '') : 'No matches';
}
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
    tile('c1', 'today', d[0] ? d[0].total : 0, 'Today · in progress') +
    tile('c2', 'yday', d[1] ? d[1].total : 0, 'Yesterday') +
    tile('c3', 'total', total, d.length + ' days') +
    tile('c4', 'top', top ? top[1] : 0, top ? 'Top game · ' + esc(top[0]) : 'Top game') + '</div></div>';
}
let loadVersion = 0;
const projectFilter = document.getElementById('project-filter'), gameFilter = document.getElementById('game-filter');
function scopeQuery(project = projectFilter.value) { return '&project_id=' + encodeURIComponent(project) + '&game_id=' + encodeURIComponent(gameFilter.value); }
function loadingState() { return '<div class="skeleton" role="status" aria-label="Loading analytics"><div></div><div></div><div></div></div>'; }

function setView(flags) {
  out.hidden = flags; document.getElementById('flags-out').hidden = !flags;
  document.getElementById('overview-tab').setAttribute('aria-pressed', String(!flags));
  document.getElementById('flags-tab').setAttribute('aria-pressed', String(flags));
}
document.getElementById('overview-tab').onclick = () => setView(false);
document.getElementById('flags-tab').onclick = () => setView(true);
function errorMessage(message) { return '<div class="msg">' + esc(message) + ' <button class="secondary" data-retry>Retry</button></div>'; }
async function load() {
  const version = ++loadVersion;
  out.innerHTML = loadingState();
  document.getElementById('flags-out').innerHTML = '<div class="msg">Loading player flags…</div>';
  document.getElementById('updated').textContent = '';
  try {
    const r = await fetch('/api/stats/daily?days=' + sel.value + scopeQuery(), {credentials:'same-origin'});
    if (version !== loadVersion) return;
    if (r.status === 401) {
      out.innerHTML = '<div class="msg">Sign in to view your match analytics. <a href="/login?next=%2Fstats">Sign in to dashboard</a></div>';
      document.getElementById('flags-out').innerHTML = out.innerHTML; return;
    }
    if (!r.ok) throw new Error('Could not load analytics (' + r.status + ').');
    const data = await r.json();
    if (version !== loadVersion) return;
    if(data.filters) {
      for(const [select, items, label] of [[projectFilter,data.filters.projects,'All projects'],[gameFilter,data.filters.games,'All games']]) {
        const value = select.value;
        select.innerHTML = '<option value="">' + label + '</option>' + items.map(i => '<option value="' + esc(i.id) + '">' + esc(i.name) + '</option>').join(''); select.value = value;
      }
    }
    document.getElementById('sample-banner').hidden = !data.sample_data;
    if (!data.projects.length) { out.innerHTML = '<div class="msg">No projects in your team yet.</div>'; }
    else out.innerHTML = data.projects.map(p => {
      const d = p.days, total = d.reduce((a,x) => a+x.total,0), max = Math.max(1,...d.map(x => x.total));
      const rows = d.map(x => '<tr class="day" data-date="' + x.date + '"><td><button class="day-action" aria-expanded="false">' + x.date + ' ▾</button></td><td class="n">' + x.total + '</td><td class="games">' +
        gameBreakdown(x.games) + '</td></tr>').join('');
      const chart = [...d].reverse().map(x => '<button data-day="' + x.date + '" title="' + x.date + ': ' + x.total + ' matches" aria-label="' + x.date + ': ' + x.total + ' matches. View matches"><span style="height:' + Math.max(2,x.total/max*100) + '%"></span></button>').join('');
      return '<section class="project" data-project="' + esc(p.project_id || '') + '"><h2>' + esc(p.project) + '</h2>' + panel(d,total) + (p.comparison ? '<p class="games">Last ' + p.comparison.days + ' complete days: ' + p.comparison.completed + ' matches · Previous ' + p.comparison.days + ' complete days: ' + p.comparison.previous + ' matches · ' + (p.comparison.previous ? ((p.comparison.completed-p.comparison.previous)/p.comparison.previous*100).toFixed(1)+'% change' : 'No prior baseline') + ' · Today excluded</p>' : '') +
        '<div class="panel"><div class="panel-h">Daily match trend</div><div class="chart">' + chart + '</div><div class="chart-caption"><span>' + (d.length ? d[d.length-1].date : '') + '</span><span>Click a bar to view matches</span><span>' + (d.length ? d[0].date : '') + '</span></div></div>' +
        '<div class="toolbar"><h2>Daily breakdown</h2><label><input type="checkbox" class="hide-inactive"> Hide inactive days</label></div>' +
        '<table><thead><tr><th>Date</th><th>Matches</th><th>By game</th></tr></thead><tbody>' + rows + '</tbody></table></section>';
    }).join('');
    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB',{timeZone:'Asia/Karachi'});
    loadFlags(version);
  } catch(e) { if(version === loadVersion) { out.innerHTML = errorMessage(e.message || 'Connection failed.'); document.getElementById('flags-out').innerHTML = errorMessage('Analytics could not be loaded.'); } }
}
out.addEventListener('change', e => {
  if (!e.target.matches('.hide-inactive')) return;
  e.target.closest('.project').querySelectorAll('tr.day').forEach(row => {
    row.hidden = e.target.checked && Number(row.querySelector('.n').textContent) === 0;
    if(row.nextElementSibling?.classList.contains('detail')) row.nextElementSibling.hidden = row.hidden;
  });
});
out.addEventListener('click', async e => {
  if(e.target.closest('[data-retry]')) return load();
  const chartDay = e.target.closest('[data-day]');
  if(chartDay) { const row = [...chartDay.closest('.project').querySelectorAll('tr.day')].find(r => r.dataset.date === chartDay.dataset.day); row.hidden = false; row.scrollIntoView({block:'center',behavior:'smooth'}); if(!row.nextElementSibling?.classList.contains('detail')) row.querySelector('button').click(); return; }
  const btn = e.target.closest('button[data-tx]');
  if (btn) { e.stopPropagation(); return showLog(btn); }
  const fp = e.target.closest('.fph');
  if (fp) return toggleFlags(fp.parentElement);
  if(e.target.closest('details, [data-copy-id]')) return;
  const tr = e.target.closest('tr.day');
  if (!tr) return;
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); tr.querySelector('button').setAttribute('aria-expanded','false'); return; }
  tr.querySelector('button').setAttribute('aria-expanded','true');
  const row = document.createElement('tr'); row.className = 'detail';
  row.innerHTML = '<td colspan="3">Loading…</td>'; tr.after(row);
  try {
  const r = await fetch('/api/stats/matches?date=' + tr.dataset.date + scopeQuery(tr.closest('.project').dataset.project), {credentials: 'same-origin'});
  if(!r.ok) throw new Error('Could not load matches (' + r.status + '). Close and reopen this day to retry.');
  const data = await r.json();
  renderMatches(row.firstChild, data.matches);
  } catch(e) { row.firstChild.textContent = e.message || 'Connection failed. Close and reopen this day to retry.'; }
});
function renderMatches(target, matches) {
  if(!matches.length) { target.textContent = 'No recorded matches for this day.'; return; }
  target.innerHTML = '<section aria-label="Daily matches"><div class="match-tools"><input aria-label="Search matches" placeholder="Search player, ID or match…"><select aria-label="Filter matches by game"><option value="">All games</option>' +
    [...new Set(matches.map(m => m.game))].sort().map(g => '<option>' + esc(g) + '</option>').join('') + '</select></div><div class="mlist"></div><div class="match-tools"><button class="secondary previous">Previous</button><span class="status" role="status"></span><button class="secondary next">Next</button></div></section>';
  const search = target.querySelector('input'), game = target.querySelector('select'), list = target.querySelector('.mlist');
  let page = 0;
  function draw() {
    const query = search.value.toLowerCase().trim();
    const filtered = matches.filter(m => (!game.value || m.game === game.value) &&
      [m.game,m.transaction_id,m.winner,m.winner_id,...(m.players || []).flatMap(p => [p.name,p.id])].join(' ').toLowerCase().includes(query));
    const pages = Math.max(1,Math.ceil(filtered.length/10)); page = Math.min(page,pages-1);
    list.innerHTML = filtered.slice(page*10,page*10+10).map(m =>
      '<article><div class="mrow"><b>' + esc(m.time) + '</b><span>' + esc(m.game) + '</span><span>Winner: ' + esc(m.winner || '–') +
      (m.winner_id && m.winner_id !== 'draw' ? ' ' + playerId(m.winner_id) : '') + '</span>' +
      ((m.players || []).length ? '<span class="games">' + m.players.map(p => esc(p.name) + ' ' + playerId(p.id)).join(' vs ') + '</span>' : '') +
      '<span class="games">' + esc(m.events) + ' events</span><button class="lnk" data-tx="' + esc(m.transaction_id) + '">View log</button>' +
      '<a class="lnk" href="/api/stats/match-log/' + encodeURIComponent(m.transaction_id) + '?download=1">JSON</a>' +
      '<button class="lnk" data-tx="' + esc(m.transaction_id) + '" data-open="srv">Server logs</button></div></article>').join('') || '<div class="msg">No matches fit these filters.</div>';
    target.querySelector('[role="status"]').textContent = filtered.length + ' matches · Page ' + (page+1) + ' of ' + pages;
    target.querySelector('.previous').disabled = page === 0; target.querySelector('.next').disabled = page >= pages-1;
  }
  search.oninput = game.onchange = () => { page = 0; draw(); };
  target.querySelector('.previous').onclick = () => { page--; draw(); };
  target.querySelector('.next').onclick = () => { page++; draw(); };
  draw();
}
async function showLog(btn) {
  const box = btn.closest('.mrow').parentElement;
  const want = btn.dataset.open || 'flow';
  const open = box.querySelector('.viewer');
  if (open) {
    open.remove();
    if (open.dataset.mode === want) return;   // same button again closes; the other button switches view
  }
  // Put the viewer in place before loading, so a second click while loading closes it instead of opening a copy.
  const v = document.createElement('dialog'); v.className = 'viewer'; v.dataset.mode = want;
  v.innerHTML = '<span class="games">Loading…</span>'; box.append(v); v.showModal(); v.addEventListener('close', () => { v.remove(); btn.focus(); });
  try {
  const r = await fetch('/api/stats/match-log/' + encodeURIComponent(btn.dataset.tx), {credentials: 'same-origin'});
  if (!r.ok) throw new Error('Could not load (' + r.status + ')');
  const j = await r.json();
  v.innerHTML = '<div class="vbar"><button class="secondary close-viewer">Close log</button><div class="seg"><button class="on" data-mode="flow">Flow</button><button data-mode="raw">Raw JSON</button><button data-mode="srv">Server logs</button></div>' +
    '<span class="games">' + esc([j.game, j.reason, j.scores].filter(Boolean).join(' · ')) + '</span>' +
    (j.players && j.players.length ? '<span class="games">Players: ' + j.players.map(p => esc(p.name) + ' <span class="uid">ID ' + esc(p.id) + '</span>' + (p.role ? ' (' + esc(p.role) + ')' : '')).join(' · ') + '</span>' : '') +
    '</div><div class="vbody"></div>';
  const body = v.querySelector('.vbody');
  const show = mode => {
    v.dataset.mode = mode; body.dataset.mode = mode;
    v.querySelectorAll('.seg button').forEach(b => { b.classList.toggle('on', b.dataset.mode === mode); b.setAttribute('aria-pressed',String(b.dataset.mode === mode)); });
    if (mode === 'raw') { body.innerHTML = '<pre class="raw"></pre>'; body.firstChild.textContent = JSON.stringify(j, null, 2); }
    else if (mode === 'srv') serverLogs(body, btn.dataset.tx);
    else renderFlow(body, j);
  };
  v.querySelector('.seg').onclick = e => { const b = e.target.closest('button'); if (b) show(b.dataset.mode); };
  v.querySelector('.close-viewer').onclick = () => v.close();
  show(want);
  } catch(e) { v.innerHTML = '<div class="msg">Could not load this log. <button class="secondary retry-log">Retry</button> <button class="secondary close-log">Close</button></div>'; v.querySelector('.close-log').onclick = () => v.close(); v.querySelector('.retry-log').onclick = () => { v.close(); showLog(btn); }; }
}

// The Edgegap container log of the server that ran this match (from the S3 bucket), with a search box.
const SRV = {};
async function serverLogs(body, tx) {
  body.innerHTML = '<span class="games">Loading the server log…</span>';
  try {
    if (!SRV[tx]) {
      const r = await fetch('/api/stats/server-logs/for/' + encodeURIComponent(tx), {credentials:'same-origin'});
      const j = await r.json();
      if(!r.ok) throw new Error(j.error || 'Could not load server logs (' + r.status + ').');
      SRV[tx] = j;
    }
    const j = SRV[tx];
    if(!body.isConnected || body.dataset.mode !== 'srv') return;
    body.innerHTML = '<div class="vbar"><input class="sq" aria-label="Search server logs" placeholder="Search logs or player ID…"><select aria-label="Log severity"><option value="all">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select><button class="lnk sd">Download</button><span class="games count" role="status"></span></div>' +
      '<p class="games">' + esc(j.name) + (j.cut ? ' · Truncated: only part of the server log is available.' : '') + '</p><pre class="raw srv"></pre>';
    const pre = body.querySelector('pre'), q = body.querySelector('input'), severity = body.querySelector('select');
    const level = text => /exception|error|failed/i.test(text) ? 'error' : /warn/i.test(text) ? 'warning' : 'info';
    const draw = () => {
      const rows = j.lines.filter(l => l.text.toLowerCase().includes(q.value.trim().toLowerCase()) && (severity.value === 'all' || level(l.text) === severity.value));
      body.querySelector('.count').textContent = rows.length + ' of ' + j.lines.length + ' loaded lines · ' + j.total_lines + ' total';
      pre.innerHTML = rows.map(l => '<span class="' + ({error:'le',warning:'lw',info:''}[level(l.text)]) + '">' +
        (l.time ? '<span class="lt">' + esc(l.time.replace('T',' ').slice(0,23)) + '</span>  ' : '') + esc(l.text) + '</span>').join(String.fromCharCode(10)) || 'No lines match these filters.';
    };
    q.oninput = severity.onchange = draw;
    body.querySelector('.sd').onclick = () => {
      const a = document.createElement('a'), url = URL.createObjectURL(new Blob([j.lines.map(l => (l.time ? l.time+'  ' : '')+l.text).join(String.fromCharCode(10))],{type:'text/plain'}));
      a.href = url; a.download = 'server-'+tx+'.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    };
    draw();
  } catch(e) { body.innerHTML = '<div class="msg">' + esc(e.message || 'Connection failed.') + ' <button class="secondary">Retry server logs</button></div>'; body.querySelector('button').onclick = () => serverLogs(body,tx); }
}

// Event kind → card colour / label, from the [Snooker Flow] wording.
function kindOf(msg) {
  const m = msg.toLowerCase();
  if (m.startsWith('result sent') || m.includes('game over') || m.startsWith('result:')) return ['res', 'Result'];
  if (m.startsWith('foul') || m.includes('missed') || m.includes('penalty')) return ['foul', 'Foul'];
  if (m.includes('potted the')) return ['pot', 'Pot'];
  if (m.startsWith('score updated')) return ['score', 'Score'];
  if (m.includes('makes the break') || m.includes(' shoots') || m.includes('automatic shot') || m.includes('timer ran out')) return ['shot', 'Shot'];
  if (m.includes("turn ends") || m.startsWith('turn continues')) return ['turn', 'Turn'];
  return ['info', 'Info'];
}

// Split the events into visits: match start, then one group per player turn ("turn → X"), then the result.
function groupsOf(events) {
  const groups = [{title: 'Match start', player: null, items: []}];
  let cur = groups[0];
  for (const ev of events) {
    const msg = ev.msg || '';
    let p = null;
    const toss = msg.match(/^(.+) won the toss/);
    const turn = msg.match(/^turn → (.+)$/);
    if (toss) { cur.items.push(ev); p = toss[1]; }
    else if (turn) p = turn[1];
    if (p) { cur = {title: p, player: p, items: []}; groups.push(cur); if (toss) continue; continue; }
    if (kindOf(msg)[0] === 'res') {
      if (!cur.result) { cur = {title: 'Result', player: null, result: true, items: []}; groups.push(cur); }
    }
    cur.items.push(ev);
  }
  return groups.filter(g => g.items.length || g.player);
}

function renderFlow(body, j) {
  const events = j.events || [];
  if (!events.length) { body.innerHTML = '<span class="games">No events.</span>'; return; }
  const groups = groupsOf(events);
  const players = [];
  groups.forEach(g => { if (g.player && !players.includes(g.player)) players.push(g.player); });
  const pc = name => name === null ? '' : ' p' + (players.indexOf(name) % 4);
  const idOf = {};
  (j.players || []).forEach(p => { if (p.name) idOf[p.name] = p.id; });
  (j.flags || []).forEach(f => { if (f.player_name && f.player_id && !idOf[f.player_name]) idOf[f.player_name] = f.player_id; });
  if (j.winner_name && j.winner_id && !idOf[j.winner_name]) idOf[j.winner_name] = j.winner_id;
  let turnNo = 0;
  body.innerHTML = '<div class="flow">' + groups.map(g => {
    const cls = g.result ? ' res' : g.player === null ? ' start' : pc(g.player);
    const sub = g.result ? (j.scores || '') : g.player === null ? (j.game || '') : 'Turn ' + (++turnNo);
    const t0 = g.items.length && typeof g.items[0].t === 'number' ? g.items[0].t.toFixed(0) + 's' : '';
    return '<div class="frow"><div class="node' + cls + '"><div class="nt">' + esc(g.title) + '</div><div class="ns">' + esc(sub) +
      (t0 ? ' · ' + t0 : '') + '</div>' + (g.player && idOf[g.player] ? '<div class="nid">ID ' + esc(idOf[g.player]) + '</div>' : '') +
      (g.result && j.winner_id && j.winner_id !== 'draw' ? '<div class="nid">winner ID ' + esc(j.winner_id) + '</div>' : '') + '</div><svg class="links"></svg><div class="evs">' +
      (g.items.length ? g.items.map(ev => {
        const k = kindOf(ev.msg || '');
        return '<div class="ev ' + k[0] + '"><span class="ek">' + k[1] + '</span><span class="em">' + esc(ev.msg) +
          '</span><span class="et">' + (typeof ev.t === 'number' ? ev.t.toFixed(1) + 's' : '') + '</span></div>';
      }).join('') : '<div class="ev info"><span class="em">—</span></div>') + '</div></div>';
  }).join('') + '</div>';
  requestAnimationFrame(() => drawLinks(body));
}

// Curved connectors from each turn card to its event cards (redrawn on resize).
function drawLinks(body) {
  body.querySelectorAll('.frow').forEach(row => {
    const svg = row.querySelector('svg.links'), node = row.querySelector('.node');
    svg.style.height = '0px';
    const evs = row.querySelector('.evs');
    const h = Math.max(evs.offsetHeight, node.offsetHeight);
    svg.style.height = h + 'px';
    const rr = row.getBoundingClientRect(), sr = svg.getBoundingClientRect(), nr = node.getBoundingClientRect();
    const w = sr.width;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const y0 = nr.top - rr.top + nr.height / 2;
    const col = getComputedStyle(node).getPropertyValue('--c').trim() || '#888';
    svg.innerHTML = [...row.querySelectorAll('.ev')].map(ev => {
      const er = ev.getBoundingClientRect(), y1 = er.top - rr.top + er.height / 2;
      return '<path d="M0 ' + y0 + ' C ' + (w * 0.55) + ' ' + y0 + ', ' + (w * 0.45) + ' ' + y1 + ', ' + w + ' ' + y1 +
        '" fill="none" stroke="' + col + '" stroke-width="3" stroke-linecap="round" opacity=".85"/>';
    }).join('');
  });
}
window.addEventListener('resize', () => document.querySelectorAll('.vbody').forEach(b => b.querySelector('.flow') && drawLinks(b)));
const FLAG_LABEL = {
  false_win_claim: 'False win claim', unbacked_win_claim: 'Unbacked win claim', out_of_turn: 'Out of turn',
  roll_twice: 'Repeated roll', tampered_request: 'Invalid request', one_sided_pair: 'Repeated one-sided results', fast_win_claim: 'Unusually fast win claim',
  illegal_move: 'Illegal move', finish_too_far: 'Finish far from line', finish_missing_checkpoints: 'Missed checkpoints',
  finish_before_start: 'Finish before start', replayed_action: 'Replayed action', many_disconnect_wins: 'Many disconnect wins',
};
const flagLabel = c => FLAG_LABEL[c] || c;
let flagPlayers = new Map();
function patternEvidence(player) {
  const evidence = player?.evidence || {};
  let html = '';
  if(evidence.one_sided_pair) {
    const pair = evidence.one_sided_pair;
    html += '<div class="msg"><b>Repeated opponent</b><p>' + esc(pair.with || pair.with_id) + ' ' + playerId(pair.with_id) + '</p><p>' + esc(pair.matches) + ' matches · ' + esc(pair.wins) + ' wins · ' + esc(pair.losses) + ' losses' + (pair.avg_seconds != null ? ' · Average '+esc(pair.avg_seconds)+' seconds' : '') + '</p></div>';
  }
  if(evidence.disconnect_wins?.length) html += '<div class="msg"><b>Disconnect-win evidence</b><p class="games">Up to 20 supporting matches</p>' + evidence.disconnect_wins.map(m =>
    '<article><div class="mrow"><span>' + esc(m.game || '') + ' · ' + esc(m.reason || '') + '</span><span>Opponent: ' + esc(m.opponent || m.opponent_id || 'Unknown') + '</span>' + (m.opponent_id ? playerId(m.opponent_id) : '') + '<button class="lnk" data-tx="' + esc(m.transaction_id) + '">View log</button></div></article>').join('') + '</div>';
  return html;
}

async function loadFlags(version) {
  const target = document.getElementById("flags-out");
  try {
  const r = await fetch('/api/stats/flags?days=' + sel.value + scopeQuery(), {credentials: 'same-origin'});
  if (!r.ok) throw new Error('Could not load player flags (' + r.status + ').');
  const data = await r.json();
  if(version !== loadVersion) return;
  const box = document.createElement('div');
  box.className = 'panel flags';
  flagPlayers = new Map(data.players.map(p => [p.player_id,p]));
  const rows = data.players.map(p =>
    '<div class="fp" data-pid="' + esc(p.player_id) + '"><button class="fph" aria-expanded="false"><b>' + esc(p.name) + '</b><span class="uid">ID ' + esc(p.player_id) + '</span>' +
    '<span class="fcount" title="Event flags plus generated pattern signals">' + p.count + ' review signal' + (p.count === 1 ? '' : 's') + '</span>' +
    Object.entries(p.codes).map(([c, n]) => '<span class="chip">' + esc(flagLabel(c)) + ' ×' + n + '</span>').join('') +
    '<span class="sp"></span><span class="games">' + esc(p.games.join(', ')) + (p.last ? ' · last ' + esc(p.last) : '') + '</span></button></div>').join('');
  box.innerHTML = '<div class="panel-h">' + FLAG_ICON + 'Flagged players</div>' +
    '<div class="games fnote">Review signals need investigation; they are not proof of cheating. Pattern counts represent supporting matches and can overlap.</div>' +
    (rows ? '<div class="flist">' + rows + '</div>' : '<div class="games fempty">No flagged players in this period.</div>') +
    '<div class="games fnote">A flag means the match server saw something the rules do not allow — review the player, it is not proof. ' +
    'Many disconnect wins = ' + data.disconnect_win_threshold + '+ wins because the opponent left.</div>';
  target.replaceChildren(box);
  document.getElementById('flags-tab').textContent = 'Player flags (' + data.players.length + ')';
  } catch(e) { if(version === loadVersion) target.innerHTML = errorMessage(e.message || 'Could not load player flags.'); }
}
const FLAG_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 2h2v20H5V2zm3 1h11l-2.5 4L19 11H8V3z"/></svg>';

async function toggleFlags(fp) {
  const header = fp.querySelector('.fph'), open = fp.querySelector('.fdetail');
  if (open) { open.remove(); header.setAttribute('aria-expanded','false'); return; }
  header.setAttribute('aria-expanded','true');
  const d = document.createElement('div'); d.className = 'fdetail mlist'; d.textContent = 'Loading evidence…'; fp.append(d);
  try {
    const r = await fetch('/api/stats/flags/' + encodeURIComponent(fp.dataset.pid) + '?days=' + sel.value + scopeQuery(), {credentials:'same-origin'});
    if(!r.ok) throw new Error('Could not load evidence (' + r.status + '). Close and reopen to retry.');
    const data = await r.json();
    d.innerHTML = (data.flags.length ? data.flags.map(f =>
      '<div><div class="mrow"><b>' + esc(f.time) + '</b><span>' + esc(f.game || '') + '</span><span class="chip">' + esc(flagLabel(f.code)) +
      '</span><span class="sp">' + esc(f.detail || '') + '</span>' +
      (f.transaction_id ? '<button class="lnk" data-tx="' + esc(f.transaction_id) + '">View log</button>' : '') + '</div></div>').join('')
      : '<span class="games">This player has pattern signals from match results. Open the Overview days to review supporting matches.</span>') + '<div>' + playerId(fp.dataset.pid) + '</div>' + patternEvidence(flagPlayers.get(fp.dataset.pid));
  } catch(e) { d.textContent = e.message || 'Connection failed. Close and reopen to retry.'; }
}
// ── Analyze with AI: copies a ready prompt (with a read-only 7-day token) for Claude Code / Codex ──
const NL = String.fromCharCode(10);
const aiBtn = document.getElementById('ai-btn'), aiBox = document.getElementById('ai-box');
aiBtn.onclick = () => { aiBox.hidden = !aiBox.hidden; };
document.getElementById('ai-copy').onclick = async () => {
  const status = document.getElementById('ai-status'), out = document.getElementById('ai-prompt');
  const copyButton = document.getElementById('ai-copy'); copyButton.disabled = true;
  try {
  status.textContent = 'Making a read-only token…';
  const r = await fetch('/api/stats/ai-token', {method: 'POST', credentials: 'same-origin'});
  if (!r.ok) { status.textContent = r.status === 401 ? 'Sign in to the dashboard first.' : 'Could not make a token (' + r.status + ').'; return; }
  const t = await r.json();
  const days = document.getElementById('ai-days').value, lang = document.getElementById('ai-lang').value;
  const player = document.getElementById('ai-player').value.trim();
  const base = location.origin;
  const auth = '-H "Authorization: Bearer ' + t.token + '"';
  const lines = [
    'You are reviewing Games Panda multiplayer match data for the admin team. The data is read-only.',
    '',
    'Fetch it:',
    'curl -s ' + auth + ' "' + base + '/api/stats/ai-export?days=' + days + '"',
  ];
  if (player) lines.push('curl -s ' + auth + ' "' + base + '/api/stats/flags/' + encodeURIComponent(player) + '"');
  lines.push(
    'For a closer look at any match: curl -s ' + auth + ' "' + base + '/api/stats/match-log/<transaction_id>"',
    '',
    'Then write a short report in ' + lang + ':',
    player ? '1. Everything about user ID ' + player + ': matches, flags, patterns, and whether this looks like cheating, bad luck or a bad network.'
           : '1. Overview: matches per day and per game, trends, anything unusual.',
    '2. Players the admin should review first — always with their user ID — ranked, with the evidence and why.',
    '3. Patterns worth attention (many disconnect wins, repeated flags, the same opponents again and again, odd results per game).',
    '4. Games that look broken or unfair (many draws, time-overs or disconnects).',
    '5. Concrete next steps for the admin.',
    '',
    'Rules: flags are hints, not proof — say how sure you are. Use only this data; never invent numbers or IDs. ' +
    'Keep it short and easy to act on. The token is read-only and expires in ' + t.expires_in_days + ' days.');
  out.value = lines.join(NL);
  out.hidden = false;
  try { await navigator.clipboard.writeText(out.value); status.textContent = 'Copied — paste it into Claude Code or Codex.'; }
  catch (e) { out.select(); status.textContent = 'Select the text below and copy it (the browser blocked the clipboard).'; }
  } catch(e) { status.textContent = 'Could not prepare the prompt. Check your connection and retry.'; } finally { copyButton.disabled = false; }
};
document.getElementById('flags-out').addEventListener('click', e => {
  if(e.target.closest('[data-retry]')) return load();
  const btn = e.target.closest('button[data-tx]'); if(btn) return showLog(btn);
  const header = e.target.closest('.fph'); if(header) toggleFlags(header.closest('.fp'));
});
document.getElementById('refresh').onclick = load;
projectFilter.onchange = gameFilter.onchange = sel.onchange = load; load();
</script></body></html>"""
