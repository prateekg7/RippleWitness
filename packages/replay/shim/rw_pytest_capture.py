"""Pytest capture plugin for RippleWitness test harvesting (F-24).

Loaded with `pytest -p rw_pytest_capture` and PYTHONPATH pointing at this
directory (no writes to the subject tree). Records per-test outcomes and
outgoing HTTP calls as JSONL to $RW_HARVEST_LOG:

  {"kind": "test", "id": "<nodeid>", "outcome": "passed|failed|skipped|error"}
  {"kind": "call", "test": "<nodeid>", "method": "...", "url": "...",
   "headers": {...}, "body": <json|string|null>, "truncated": bool}

Capture points: http.client (covers urllib, requests, urllib3) and httpx
sync clients (guarded import). Authorization/cookie headers are dropped, bodies
capped at 64 KiB. Best effort: any capture failure degrades to fewer rows,
never to a broken test session.
"""

import json
import os

LOG_PATH = os.environ.get("RW_HARVEST_LOG", "")
BODY_CAP = 64 * 1024
_current_test = ["(setup)"]


def _emit(obj):
    if not LOG_PATH:
        return
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(obj) + "\n")
    except OSError:
        pass


def _clean_headers(headers):
    try:
        items = dict(headers or {})
    except (TypeError, ValueError):
        return {}
    return {k: v for k, v in items.items() if k.lower() not in ("authorization", "cookie", "set-cookie")}


def _clean_body(body):
    if body is None:
        return None, False
    if isinstance(body, (bytes, bytearray)):
        try:
            text = bytes(body).decode("utf-8")
        except UnicodeDecodeError:
            return None, True
    else:
        text = str(body)
    if len(text) > BODY_CAP:
        return text[:BODY_CAP], True
    try:
        return json.loads(text), False
    except ValueError:
        return text, False


def _record_call(method, url, headers, body):
    clean_body, truncated = _clean_body(body)
    _emit({
        "kind": "call",
        "test": _current_test[0],
        "method": str(method or "GET").upper(),
        "url": str(url or ""),
        "headers": _clean_headers(headers),
        "body": clean_body,
        "truncated": truncated,
    })


def pytest_runtest_setup(item):
    _current_test[0] = item.nodeid


def pytest_runtest_logreport(report):
    if report.when != "call":
        return
    outcome = "passed" if report.passed else ("skipped" if report.skipped else "failed")
    _emit({"kind": "test", "id": report.nodeid, "outcome": outcome})


def pytest_collection_finish(session):
    _emit({"kind": "hello", "count": len(list(session.items))})


# --- capture points (installed at import; each guarded) ---

try:
    import http.client as _httpc

    _orig_request = _httpc.HTTPConnection.request

    def _patched_request(self, method, url, body=None, headers=None, **kw):
        try:
            host = self.host
            port = self.port
            full = url if "://" in str(url) else f"http://{host}:{port}{url}"
            _record_call(method, full, headers, body)
        except Exception:
            pass
        return _orig_request(self, method, url, body=body, headers=headers or {}, **kw)

    _httpc.HTTPConnection.request = _patched_request
except ImportError:
    pass

try:
    import httpx as _httpx

    _orig_send = _httpx.Client.send

    def _patched_send(self, request, **kw):
        try:
            _record_call(request.method, str(request.url), dict(request.headers), request.content)
        except Exception:
            pass
        return _orig_send(self, request, **kw)

    _httpx.Client.send = _patched_send
except ImportError:
    pass
