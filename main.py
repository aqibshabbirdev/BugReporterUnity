"""Wasmer entry point. The Flask app lives in backend/app; this file exists so the
platform's python preset finds a root main.py and a root requirements.txt."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend"))

from app import create_app  # noqa: E402

app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
