"""SQLite layer. One file on the Wasmer volume; WAL mode so a dashboard read never blocks an ingest write.

Schema notes:
- api key: only the sha256 HASH is stored. The plaintext (br_live_...) is shown once at project creation.
- builds: auto-upserted on the first report that carries an unseen version string.
- issues.metadata: the game's SetMetadata dict, stored as JSON text — SQLite json1 can query it if ever needed.
"""
import hashlib
import os
import sqlite3
import time
import uuid

DB_PATH = os.environ.get("BR_DB_PATH", "/data/bugreporter.db")  # /data = the Wasmer volume mount

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    pw_hash     TEXT NOT NULL,          -- scrypt via hashlib, no external deps
    role        TEXT NOT NULL DEFAULT 'dev',   -- admin | dev | tester
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id),
    version      TEXT NOT NULL,
    platform     TEXT,
    first_seen_at INTEGER NOT NULL,
    report_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_id, version)
);
CREATE TABLE IF NOT EXISTS issues (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id),
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    severity       TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | crash
    status         TEXT NOT NULL DEFAULT 'open',     -- open | fixed_in_build | verified | wont_fix
    fixed_in_build TEXT,
    build_version  TEXT NOT NULL,
    platform       TEXT, device_model TEXT, os_version TEXT,
    screen_resolution TEXT, memory_mb INTEGER,
    metadata       TEXT NOT NULL DEFAULT '{}',
    has_screenshot INTEGER NOT NULL DEFAULT 0,
    has_logs       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_project_created ON issues(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_project_build   ON issues(project_id, build_version);
CREATE TABLE IF NOT EXISTS comments (
    id         TEXT PRIMARY KEY,
    issue_id   TEXT NOT NULL REFERENCES issues(id),
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with connect() as conn:
        conn.executescript(_SCHEMA)


def now() -> int:
    return int(time.time())


def new_id() -> str:
    return uuid.uuid4().hex


# ── api keys ────────────────────────────────────────────────────────────────

def hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def make_api_key() -> str:
    return "br_live_" + uuid.uuid4().hex


# ── passwords (scrypt from the stdlib — no bcrypt dependency to compile for WASIX) ──

def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return salt.hex() + "$" + dk.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, dk_hex = stored.split("$", 1)
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
        return dk.hex() == dk_hex
    except Exception:
        return False
