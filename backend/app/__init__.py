"""Flask app factory. Serves the JSON API and (in production) the built dashboard from static/."""
import os

from flask import Flask, send_from_directory

from . import db


def create_app() -> Flask:
    static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # hard cap on any request body

    # Never die at startup on a DB problem — come up, serve /api/health with the reason, and retry
    # the schema init lazily on the next request. A crashed worker gives an opaque edge 500; a live
    # /api/health tells us exactly what to fix (missing env vars, unreachable host, bad password).
    app.config["DB_INIT_ERROR"] = None
    try:
        db.init_db()
    except Exception as e:  # noqa: BLE001
        app.config["DB_INIT_ERROR"] = f"{type(e).__name__}: {e}"
        app.logger.error("DB init failed: %s", app.config["DB_INIT_ERROR"])

    @app.get("/api/health")
    def health():
        import os as _os
        present = [n for n in ("BR_DB_HOST", "DB_HOST", "MYSQL_HOST", "DB_URL", "DATABASE_URL",
                               "DB_PORT", "DB_NAME", "DB_USERNAME", "DB_USER", "DB_PASSWORD")
                   if _os.environ.get(n)]
        err = app.config.get("DB_INIT_ERROR")
        if err:
            try:
                db.init_db()                      # lazy retry (env may have been fixed + redeployed)
                app.config["DB_INIT_ERROR"] = None
                err = None
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"
                app.config["DB_INIT_ERROR"] = err
        return {"db": "ok" if err is None else "error",
                "db_error": err,
                "db_env_vars_present": present}, (200 if err is None else 503)

    from . import api, ingest
    app.register_blueprint(ingest.bp)
    app.register_blueprint(api.bp)

    # Dashboard: serve the React build; unknown paths fall through to index.html (SPA routing).
    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def spa(path):
        if path and os.path.exists(os.path.join(static_dir, path)):
            return send_from_directory(static_dir, path)
        index = os.path.join(static_dir, "index.html")
        if os.path.exists(index):
            return send_from_directory(static_dir, "index.html")
        return {"service": "bugreporter", "status": "api-only (dashboard not built yet)"}, 200

    return app
