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
    # Teams: every user, project and API-tester document belongs to exactly one team (team_id columns,
    # added in _migrate), and every read is filtered by the signed-in user's team.
    """CREATE TABLE IF NOT EXISTS teams (
        id         VARCHAR(32) PRIMARY KEY,
        name       VARCHAR(80) NOT NULL,
        created_at BIGINT NOT NULL
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    # Reusable join codes; registering with one puts the new account in that team with that role.
    """CREATE TABLE IF NOT EXISTS team_invites (
        id         VARCHAR(32) PRIMARY KEY,
        team_id    VARCHAR(32) NOT NULL,
        code       VARCHAR(40) NOT NULL UNIQUE,
        role       VARCHAR(10) NOT NULL DEFAULT 'dev',
        created_by VARCHAR(190) NOT NULL,
        created_at BIGINT NOT NULL,
        uses       INT NOT NULL DEFAULT 0,
        KEY idx_team_invites_team (team_id)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
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
        -- workflow: open → pending → waiting_for_test → closed (see api.update_issue / _migrate)
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
        test_case         TEXT,
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
    # API tester (tester.py): Postman collections / environments, one JSON document per row.
    """CREATE TABLE IF NOT EXISTS tester_docs (
        id         VARCHAR(32) PRIMARY KEY,
        kind       VARCHAR(20) NOT NULL,
        name       VARCHAR(200) NOT NULL,
        data       MEDIUMTEXT NOT NULL,
        version    INT NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        updated_by VARCHAR(190) NOT NULL DEFAULT '',
        KEY idx_tester_docs_kind (kind, name)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    # A tester's verdict on one request of a collection. No row = pending.
    """CREATE TABLE IF NOT EXISTS tester_marks (
        collection_id VARCHAR(32) NOT NULL,
        item_id       VARCHAR(64) NOT NULL,
        status        VARCHAR(16) NOT NULL,
        note          TEXT NOT NULL,
        response_code INT NULL,
        marked_by     VARCHAR(190) NOT NULL,
        marked_at     BIGINT NOT NULL,
        PRIMARY KEY (collection_id, item_id)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    # A saved flow run (tester.py /api/tester/reports): step names, verdicts and test messages, as one
    # JSON document. Opened by its random id without a sign-in, so the backend team can read it.
    """CREATE TABLE IF NOT EXISTS tester_reports (
        id         VARCHAR(32) PRIMARY KEY,
        team_id    VARCHAR(32) NULL,
        title      VARCHAR(300) NOT NULL,
        data       MEDIUMTEXT NOT NULL,
        created_by VARCHAR(190) NOT NULL,
        created_at BIGINT NOT NULL,
        KEY idx_tester_reports_team (team_id, created_at)
    ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
]


DEFAULT_TEAM_NAME = os.environ.get("BR_DEFAULT_TEAM_NAME", "Games Panda")


def _has_column(conn, table: str, column: str) -> bool:
    return bool(conn.execute(
        """SELECT COUNT(*) c FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?""", (table, column)
    ).fetchone()["c"])


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

    # issues.test_case — the dev-written repro on the dashboard, kept separate from the tester's in-game
    # note (description) so editing the test case never clobbers what the tester originally reported.
    has_tc = conn.execute(
        """SELECT COUNT(*) c FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'issues' AND column_name = 'test_case'"""
    ).fetchone()["c"]
    if not has_tc:
        conn.execute("ALTER TABLE issues ADD COLUMN test_case TEXT")

    # Status workflow rename: the original set (open / fixed_in_build / verified / wont_fix) described
    # what a DEV had done; the workflow the team actually runs is a queue — open → pending →
    # waiting_for_test → closed. Remap the legacy values in place so old reports keep their meaning:
    # a "fixed in build X" report is exactly one waiting for a tester, and both end states are closed.
    # No column change, so this is a plain UPDATE — idempotent because the second run matches no rows.
    conn.execute("UPDATE issues SET status = 'waiting_for_test' WHERE status = 'fixed_in_build'")
    conn.execute("UPDATE issues SET status = 'closed' WHERE status IN ('verified', 'wont_fix')")

    # Teams. Before teams existed everything belonged to one implicit team: add the team_id columns, put
    # every existing row in the first team (created here, named DEFAULT_TEAM_NAME), and make the oldest
    # admin the owner — the one account that can create further teams.
    for table, column, ddl in (
        ("users", "team_id", "ALTER TABLE users ADD COLUMN team_id VARCHAR(32) NULL"),
        ("users", "is_owner", "ALTER TABLE users ADD COLUMN is_owner TINYINT NOT NULL DEFAULT 0"),
        ("projects", "team_id", "ALTER TABLE projects ADD COLUMN team_id VARCHAR(32) NULL, ADD KEY idx_projects_team (team_id)"),
        ("tester_docs", "team_id", "ALTER TABLE tester_docs ADD COLUMN team_id VARCHAR(32) NULL, ADD KEY idx_tester_docs_team (team_id, kind, name)"),
    ):
        if not _has_column(conn, table, column):
            conn.execute(ddl)

    # issues.assignee_id — the team member who owns a bug. NULL = unassigned; cleared when a member is removed.
    if not _has_column(conn, "issues", "assignee_id"):
        conn.execute("ALTER TABLE issues ADD COLUMN assignee_id VARCHAR(32) NULL, ADD KEY idx_issues_project_assignee (project_id, assignee_id)")
    teamless = [t for t in ("users", "projects", "tester_docs")
                if conn.execute(f"SELECT 1 FROM {t} WHERE team_id IS NULL LIMIT 1").fetchone()]
    if teamless:
        first = conn.execute("SELECT id FROM teams ORDER BY created_at LIMIT 1").fetchone()
        team_id = first["id"] if first else new_id()
        if not first:
            conn.execute("INSERT INTO teams (id, name, created_at) VALUES (?,?,?)", (team_id, DEFAULT_TEAM_NAME, now()))
        for t in teamless:
            conn.execute(f"UPDATE {t} SET team_id = ? WHERE team_id IS NULL", (team_id,))
    if not conn.execute("SELECT 1 FROM users WHERE is_owner = 1 LIMIT 1").fetchone():
        admin = conn.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").fetchone()
        if admin:
            conn.execute("UPDATE users SET is_owner = 1 WHERE id = ?", (admin["id"],))

    # utf8mb4 everywhere, in one collation. CREATE TABLE takes the database's default charset, and MariaDB
    # on cPanel defaults to 3-byte utf8 — which rejects any 4-byte character (a tester's emoji in a title →
    # error 1366 → the whole report 500s). And team_id joins compare columns across tables, which MySQL
    # refuses when one is utf8mb4_unicode_ci (our explicit tables) and the other its utf8mb4_0900_ai_ci
    # default. Convert whatever isn't utf8mb4_unicode_ci yet; tables already on it match no rows.
    for row in conn.execute(
        """SELECT table_name AS t FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
             AND table_collation <> 'utf8mb4_unicode_ci'"""
    ).fetchall():
        conn.execute(f"ALTER TABLE `{row['t']}` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")


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
