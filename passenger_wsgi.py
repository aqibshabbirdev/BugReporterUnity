"""cPanel Application Manager (Passenger) entry point. The Flask app lives in backend/app.

Config: env vars set in cPanel > Application Manager win; anything missing falls back to the
.env file next to this one (KEY=VALUE lines). That file sits outside public_html, so it is never
served over HTTP.
"""
import faulthandler
import logging
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# Diagnostics: shared hosting gives no shell and Apache's error_log is root-only, so the app keeps
# its own logs/app.log — one line per request (method/path/status/timing, no headers or cookies)
# plus a thread dump if a request runs longer than 15s. Only config key NAMES are logged.
_LOG_DIR = os.path.join(HERE, "logs")
os.makedirs(_LOG_DIR, exist_ok=True)
_log = open(os.path.join(_LOG_DIR, "app.log"), "a", buffering=1)
_t0 = time.time()
_log.write("\n=== boot pid=%d %s python=%s\n" % (os.getpid(), time.strftime("%Y-%m-%d %H:%M:%S"), sys.version.split()[0]))

# cPanel-specific defaults, set before .env is read so the old Docker-era values in it
# (/data/uploads, a container hostname) can't win. Application Manager env vars still override.
os.environ.setdefault("BR_UPLOAD_DIR", os.path.join(os.path.dirname(HERE), "bugreporter_data", "uploads"))
os.environ.setdefault("DB_HOST", "localhost")


def _load_env_file(path):
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_env_file(os.path.join(HERE, ".env"))

sys.path.insert(0, os.path.join(HERE, "backend"))

from app import create_app  # noqa: E402

_log.write("env keys: %s\n" % ",".join(sorted(k for k in os.environ if k.startswith(("DB_", "BR_", "MYSQL_")))))
_log.write("db target: host=%s port=%s name=%s user=%s\n" % tuple(
    os.environ.get(k) for k in ("DB_HOST", "DB_PORT", "DB_NAME", "DB_USERNAME")))
_app = create_app()
# Flask logs handled 500s (with traceback) through app.logger, which Passenger sends to Apache's
# root-only error_log — mirror it into logs/app.log so a failing endpoint shows its traceback here.
_handler = logging.StreamHandler(_log)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
_app.logger.addHandler(_handler)
_app.logger.setLevel(logging.INFO)
_log.write("create_app done in %.1fs, DB_INIT_ERROR=%s\n" % (time.time() - _t0, _app.config.get("DB_INIT_ERROR")))

_REQ_KEYS = ("REQUEST_METHOD", "SCRIPT_NAME", "PATH_INFO", "REQUEST_URI", "QUERY_STRING",
             "HTTP_HOST", "SERVER_PROTOCOL", "REMOTE_ADDR")


def application(environ, start_response):
    t0 = time.time()
    _log.write("req " + " ".join("%s=%r" % (k, environ.get(k)) for k in _REQ_KEYS) + "\n")
    faulthandler.dump_traceback_later(15, file=_log)
    status = ["?"]

    def _start_response(s, headers, exc_info=None):
        status[0] = s
        return start_response(s, headers, exc_info)

    try:
        return _app(environ, _start_response)
    except Exception as e:  # noqa: BLE001
        _log.write("req EXC %r\n" % (e,))
        raise
    finally:
        faulthandler.cancel_dump_traceback_later()
        _log.write("req -> %s in %.2fs\n" % (status[0], time.time() - t0))
