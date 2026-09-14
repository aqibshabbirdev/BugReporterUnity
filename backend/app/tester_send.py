"""Server-side request runner for the API tester, with the guard rails a shared host needs.

A request sent from here starts on the hosting server, so without limits any signed-in user could use it
to reach what only that server can: MariaDB and cPanel/WHM on the same machine, the other sites by IP,
the provider's metadata endpoint, a private network. So:

- only http:// and https://;
- EVERY address the hostname resolves to must be globally routable (ipaddress.is_global) and must not be
  this machine's own address — its public IP counts as "global", and it fronts every site on the box.
  Own addresses are found from the hostname; TESTER_BLOCKED_IPS adds any it can't see (NAT, extra IPs);
- the socket connects to the address that was checked, never to a second DNS answer (no rebinding);
- redirects come back to the caller instead of being followed, so a public URL can't bounce us inward;
- a timeout and a response-size cap.

localhost / LAN APIs are what the page's "send from browser" mode is for.
"""
import base64
import functools
import http.client
import ipaddress
import os
import secrets
import socket
import ssl
import time
from urllib.parse import urlencode, urlsplit

TIMEOUT = 30
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
# Set by the connection itself, or would make the body unreadable (we don't decompress).
DROPPED_HEADERS = {"host", "content-length", "connection", "transfer-encoding", "keep-alive",
                   "proxy-connection", "upgrade", "te", "trailer", "accept-encoding"}


class Refused(Exception):
    """The request was not sent: bad input or a destination the guard rejects."""


class SendFailed(Exception):
    """The request was attempted and failed on the wire (DNS, TLS, timeout, reset)."""


@functools.lru_cache(maxsize=1)
def _own_ips():
    """This server's addresses, from what its hostname resolves to (cPanel hosts are named after their IP)."""
    out = set()
    for name in {socket.gethostname(), socket.getfqdn()}:
        try:
            for info in socket.getaddrinfo(name, None):
                out.add(ipaddress.ip_address(info[4][0].split("%", 1)[0]))
        except (socket.gaierror, UnicodeError, ValueError):
            pass
    return frozenset(out)


def _blocked_ips():
    out = set(_own_ips())
    for raw in os.environ.get("TESTER_BLOCKED_IPS", "").split(","):
        raw = raw.strip()
        if raw:
            try:
                out.add(ipaddress.ip_address(raw))
            except ValueError:
                pass
    return out


def _check_address(addr: str) -> str:
    ip = ipaddress.ip_address(addr.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if not ip.is_global or ip.is_multicast or ip in _blocked_ips():
        raise Refused(f"{ip} is a private or server-internal address, so the server won't send there. "
                      "For localhost/LAN APIs switch to \"Send from browser\".")
    return str(ip)


def _resolve(host: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise SendFailed(f"could not resolve {host}: {e.strerror or e}")
    addrs = [_check_address(info[4][0]) for info in infos]      # all of them, not just the first
    return next((a for a in addrs if ":" not in a), addrs[0])   # prefer IPv4


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout)
        self._address = address

    def connect(self):
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, port, address, timeout, context):
        super().__init__(host, port, timeout=timeout, context=context)
        self._address = address

    def connect(self):
        sock = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _encode_body(body):
    """-> (bytes | None, default content type | None). Form-data carries text fields only."""
    body = body or {}
    mode = body.get("mode")
    if mode == "raw":
        return str(body.get("raw") or "").encode(), body.get("contentType") or None
    fields = [(str(k), str(v)) for k, v in (body.get("fields") or [])]
    if mode == "urlencoded":
        return urlencode(fields).encode(), "application/x-www-form-urlencoded"
    if mode == "formdata":
        boundary = "----apitester" + secrets.token_hex(12)
        parts = []
        for k, v in fields:
            name = k.replace('"', "%22").replace("\r", "").replace("\n", "")
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{v}\r\n')
        parts.append(f"--{boundary}--\r\n")
        return "".join(parts).encode(), f"multipart/form-data; boundary={boundary}"
    return None, None


def send(method, url, headers=None, body=None, verify_tls=True):
    method = str(method or "GET").upper()
    if method not in METHODS:
        raise Refused(f"unsupported method {method}")
    parts = urlsplit(str(url or "").strip())
    if parts.scheme not in ("http", "https"):
        raise Refused("the URL must start with http:// or https:// (are all {{variables}} set?)")
    if not parts.hostname:
        raise Refused("the URL has no host")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise Refused("the URL has an invalid port")

    address = _resolve(parts.hostname, port)

    payload, default_type = _encode_body(body)
    out_headers = []
    for pair in headers or []:
        k, v = str(pair[0]).strip(), str(pair[1])
        if k and k.lower() not in DROPPED_HEADERS:
            out_headers.append((k, v))
    if default_type and not any(k.lower() == "content-type" for k, _ in out_headers):
        out_headers.append(("Content-Type", default_type))

    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query

    if parts.scheme == "https":
        context = ssl.create_default_context()
        if not verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        conn = _PinnedHTTPS(parts.hostname, port, address, TIMEOUT, context)
    else:
        conn = _PinnedHTTP(parts.hostname, port, address, TIMEOUT)

    started = time.monotonic()
    try:
        conn.putrequest(method, path, skip_accept_encoding=True)
        for k, v in out_headers:
            conn.putheader(k, v)
        if payload is not None:
            conn.putheader("Content-Length", str(len(payload)))
        conn.endheaders(payload)
        resp = conn.getresponse()
        data = resp.read(MAX_RESPONSE_BYTES + 1)
    except (TimeoutError, socket.timeout):
        raise SendFailed(f"no response within {TIMEOUT}s")
    except ssl.SSLError as e:
        raise SendFailed(f"TLS error: {e.reason or e} (untick \"Verify TLS\" for self-signed servers)")
    except ValueError as e:                      # e.g. a header value with a newline in it
        raise Refused(f"invalid request: {e}")
    except (OSError, http.client.HTTPException) as e:
        raise SendFailed(f"{type(e).__name__}: {e}")
    finally:
        conn.close()
    elapsed_ms = int((time.monotonic() - started) * 1000)

    truncated = len(data) > MAX_RESPONSE_BYTES
    data = data[:MAX_RESPONSE_BYTES]
    content_type = resp.getheader("Content-Type", "") or ""
    charset = "utf-8"
    for piece in content_type.split(";"):
        piece = piece.strip()
        if piece.lower().startswith("charset="):
            charset = piece.split("=", 1)[1].strip().strip('"') or "utf-8"
    try:
        text, b64 = data.decode(charset), None
    except (UnicodeDecodeError, LookupError):
        text, b64 = None, base64.b64encode(data[:2 * 1024 * 1024]).decode()

    return {
        "status": resp.status,
        "reason": resp.reason,
        "headers": resp.getheaders(),
        "timeMs": elapsed_ms,
        "size": len(data),
        "truncated": truncated,
        "body": text,
        "bodyBase64": b64,
        "address": address,
    }
