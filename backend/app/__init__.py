"""Flask app factory. Serves the JSON API and (in production) the built dashboard from static/."""
import os

from flask import Flask, send_from_directory

from . import db


def create_app() -> Flask:
    static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # hard cap on any request body

    db.init_db()

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
