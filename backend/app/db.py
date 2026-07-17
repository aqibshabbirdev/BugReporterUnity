"""MySQL layer (Wasmer's managed database). PyMySQL — pure Python, nothing to compile.

The rest of the app keeps calling `with db.connect() as conn: conn.execute(sql, params)` exactly like
the original sqlite3 code — the small _Conn shim below provides that surface on top of PyMySQL
(dict rows, per-call cursor, commit on clean exit) and converts sqlite-style `?` placeholders to
MySQL's `%s` (none of our SQL contains a literal '?').

Credentials come from the environment. Wasmer's managed-DB integration injects them; we accept the
common spellings plus explicit BR_DB_* overrides.
"""
import hashlib
import os
import time
import uuid

# pymysql import is LAZY (inside connect()): if the build skipped pip install, a top-level import
# kills the worker before Flask serves a byte — an opaque edge 500. Lazy, the app comes up and
# /api/health reports "ModuleNotFoundError: pymysql" so the build problem diagnoses itself.


def _env(*names, default=None):
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


def _creds():
    host = _env("BR_DB_HOST", "DB_HOST", "MYSQL_HOST")
    if not host:
        raise RuntimeError(
            "MySQL credentials missing — set DB_HOST/DB_PORT/DB_NAME/DB_USERNAME/DB_PASSWORD "
            "(or BR_DB_* equivalents) in the app's environment variables.")
    return dict(
        host=host,
        port=int(_env("BR_DB_PORT", "DB_PORT", "MYSQL_PORT", default="3306")),
        db=_env("BR_DB_NAME", "DB_NAME", "MYSQL_DATABASE"),
        user=_env("BR_DB_USERNAME", "DB_USERNAME", "DB_USER", "MYSQL_USER"),
        password=_env("BR_DB_PASSWORD", "DB_PASSWORD", "MYSQL_PASSWORD"),
    )


class _Cursor:
    """Result wrapper: dict rows + rowcount, mirroring what the app used from sqlite3."""

    def __init__(self, cur):
        self._cur = cur
        self.rowcount = cur.rowcount

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()


class _Conn:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        cur = self._conn.cursor()
        cur.execute(sql.replace("?", "%s"), params or None)
        return _Cursor(cur)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._conn.close()
        return False


def connect() -> "_Conn":
    # WASIX quirk: pymysql's import runs getpass.getuser(), which raises OSError when the sandbox
    # has no USER env var (pymysql only catches KeyError). Give it one before the import.
    os.environ.setdefault("USER", "wasix")
    import pymysql  # lazy — see module docstring/header note
    c = _creds()
    return _Conn(pymysql.connect(
        host=c["host"], port=c["port"], user=c["user"], password=c["password"],
        database=c["db"], charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=10,
    ))


_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS projects (
        id           VARCHAR(32) PRIMARY KEY,
        name         VARCHAR(80) NOT NULL,
        api_key_hash VARCHAR(64) NOT NULL,
        created_at   BIGINT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS users (
        id         VARCHAR(32) PRIMARY KEY,
        email      VARCHAR(190) NOT NULL UNIQUE,
        pw_hash    VARCHAR(200) NOT NULL,
        role       VARCHAR(10) NOT NULL DEFAULT 'dev',
        created_at BIGINT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS sessions (
        token      VARCHAR(64) PRIMARY KEY,
        user_id    VARCHAR(32) NOT NULL,
        expires_at BIGINT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS builds (
        id            VARCHAR(32) PRIMARY KEY,
        project_id    VARCHAR(32) NOT NULL,
        version       VARCHAR(50) NOT NULL,
        platform      VARCHAR(40),
        first_seen_at BIGINT NOT NULL,
        report_count  INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_build (project_id, version)
    )""",
    """CREATE TABLE IF NOT EXISTS issues (
        id                VARCHAR(32) PRIMARY KEY,
        project_id        VARCHAR(32) NOT NULL,
        title             VARCHAR(200) NOT NULL,
        description       TEXT,
        severity          VARCHAR(10) NOT NULL DEFAULT 'normal',
        status            VARCHAR(20) NOT NULL DEFAULT 'open',
        fixed_in_build    VARCHAR(50),
        build_version     VARCHAR(50) NOT NULL,
        game              VARCHAR(80) NOT NULL DEFAULT '',
        session           VARCHAR(80) NOT NULL DEFAULT '',
        platform          VARCHAR(40),
        device_model      VARCHAR(80),
        os_version        VARCHAR(80),
        screen_resolution VARCHAR(20),
        memory_mb         INT,
        metadata          TEXT,
        has_screenshot    TINYINT NOT NULL DEFAULT 0,
        has_logs          TINYINT NOT NULL DEFAULT 0,
        has_clip          TINYINT NOT NULL DEFAULT 0,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL,
        KEY idx_issues_project_created (project_id, created_at),
        KEY idx_issues_project_build   (project_id, build_version),
        KEY idx_issues_project_game    (project_id, game),
        KEY idx_issues_project_session (project_id, session)
    )""",
    """CREATE TABLE IF NOT EXISTS comments (
        id         VARCHAR(32) PRIMARY KEY,
        issue_id   VARCHAR(32) NOT NULL,
        author     VARCHAR(190) NOT NULL,
        text       TEXT NOT NULL,
        created_at BIGINT NOT NULL
    )""",
]


def init_db():
    with connect() as conn:
        for stmt in _SCHEMA:
            conn.execute(stmt)
        _migrate(conn)


def _migrate(conn):
    """Bring an already-created schema up to date. Runs every boot, so each step must be idempotent.

    CREATE TABLE IF NOT EXISTS never alters an existing table, so a column added after a deployment
    has to land here. We check information_schema rather than relying on ADD COLUMN IF NOT EXISTS
    (which MySQL, unlike MariaDB, does not support).
    """
    # issues.game — per-game separation under a single project/API key.
    has_game = conn.execute(
        """SELECT COUNT(*) c FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'issues' AND column_name = 'game'"""
    ).fetchone()["c"]
    if not has_game:
        conn.execute("ALTER TABLE issues ADD COLUMN game VARCHAR(80) NOT NULL DEFAULT '' AFTER build_version")
        conn.execute("ALTER TABLE issues ADD KEY idx_issues_project_game (project_id, game)")

    # issues.session — links the per-device reports of one multiplayer incident.
    has_session = conn.execute(
        """SELECT COUNT(*) c FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'issues' AND column_name = 'session'"""
    ).fetchone()["c"]
    if not has_session:
        conn.execute("ALTER TABLE issues ADD COLUMN session VARCHAR(80) NOT NULL DEFAULT '' AFTER game")
        conn.execute("ALTER TABLE issues ADD KEY idx_issues_project_session (project_id, session)")

    # issues.has_clip — lets retention find (and mark) clips without stat-ing every issue directory.
    has_clip = conn.execute(
        """SELECT COUNT(*) c FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'issues' AND column_name = 'has_clip'"""
    ).fetchone()["c"]
    if not has_clip:
        conn.execute("ALTER TABLE issues ADD COLUMN has_clip TINYINT NOT NULL DEFAULT 0 AFTER has_logs")


def now() -> int:
    return int(time.time())


def new_id() -> str:
    return uuid.uuid4().hex


# ── api keys ────────────────────────────────────────────────────────────────

def hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def make_api_key() -> str:
    return "br_live_" + uuid.uuid4().hex


# ── passwords (scrypt from the stdlib) ──────────────────────────────────────

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
