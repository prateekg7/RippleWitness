"""Minimal Flask-pattern web layer on stdlib only (no flask installed).

The *source patterns* are genuine Flask (`Flask(...)`, `@app.route(path,
methods=[...])`, `Blueprint(..., url_prefix=...)`, `register_blueprint`) so the
RippleWitness Python extractor exercises its real Flask support; the runtime is
a tiny dispatcher over http.server.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class Router:
    def __init__(self):
        self.routes = []  # (methods, path, handler)

    def route(self, path, methods=("GET",)):
        def deco(fn):
            self.routes.append((tuple(methods), path, fn))
            return fn

        return deco


class Flask(Router):
    def __init__(self, name="app"):
        super().__init__()
        self.name = name

    def register_blueprint(self, bp):
        for methods, path, fn in bp.routes:
            self.routes.append((methods, bp.url_prefix + path, fn))


class Blueprint(Router):
    def __init__(self, name, import_name, url_prefix=""):
        super().__init__()
        self.name = name
        self.url_prefix = url_prefix


def match(route_path, req_path):
    """Match '/items/<sku>' style patterns; return params dict or None."""
    rp = route_path.strip("/").split("/")
    qp = req_path.strip("/").split("/")
    if len(rp) != len(qp):
        return None
    params = {}
    for rseg, qseg in zip(rp, qp):
        if rseg.startswith("<") and rseg.endswith(">"):
            name = rseg[1:-1]
            if ":" in name:
                name = name.split(":", 1)[1]
            params[name] = qseg
        elif rseg != qseg:
            return None
    return params


class Handler(BaseHTTPRequestHandler):
    router = None

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode() or "{}")
        except ValueError:
            return {}

    def _dispatch(self):
        parsed = urlparse(self.path)
        for methods, path, fn in self.router.routes:
            if self.command not in methods:
                continue
            params = match(path, parsed.path)
            if params is None:
                continue
            query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            try:
                status, obj = fn(self, params, query)
            except _HttpError as e:
                self._send(e.status, {"error": e.message})
                return
            self._send(status, obj)
            return
        self._send(404, {"error": "not_found"})

    do_GET = _dispatch
    do_POST = _dispatch

    def log_message(self, *args):  # keep replay logs clean
        pass


class _HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def serve(router, port):
    Handler.router = router
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"shop-api-py listening:{port}", flush=True)
    httpd.serve_forever()
