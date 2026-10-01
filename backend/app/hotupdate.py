"""Static files for the Unity hot-update (HybridCLR) modules.

Passenger answers every path on the domain and the dashboard's SPA fallback turns any unknown
path into index.html, so files dropped into public_html are never reachable. This blueprint serves
/hybridclr/<file> straight from the folder the `hybridclr@` FTP account writes to.
"""
import os

from flask import Blueprint, abort, send_from_directory

bp = Blueprint("hotupdate", __name__)


def _root():
    # BR_HOTUPDATE_DIR wins; otherwise the cPanel layout: /home/<user>/public_html/<domain>/hybridclr
    return os.environ.get("BR_HOTUPDATE_DIR") or os.path.join(
        os.path.expanduser("~"), "public_html", "pandabugsreporting.com", "hybridclr")


@bp.get("/hybridclr/<path:name>")
def hotupdate_file(name):
    # No dotfiles (.ftpquota, .htaccess…) and nothing outside the folder; send_from_directory
    # already refuses ../ traversal.
    if any(part.startswith(".") for part in name.split("/")):
        abort(404)
    root = _root()
    if not os.path.isfile(os.path.join(root, name)):
        return {"error": "not found", "file": name}, 404
    # Modules are replaced in place under the same name, so clients must revalidate every time;
    # the ETag/Last-Modified that send_from_directory sets turns an unchanged file into a 304.
    resp = send_from_directory(root, name, conditional=True, max_age=0)
    resp.headers["Cache-Control"] = "no-cache"
    if name.endswith(".bytes") or name.endswith(".bundle"):
        resp.headers["Content-Type"] = "application/octet-stream"
    return resp
