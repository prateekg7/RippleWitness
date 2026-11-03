"""API tests for shop-api-py (harvest source for F-24)."""

import json
import urllib.request


def _get(base_url, path):
    with urllib.request.urlopen(base_url + path, timeout=10) as r:
        return r.status, json.load(r)


def _post(base_url, path, body):
    req = urllib.request.Request(
        base_url + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.load(r)


def test_health(base_url):
    status, body = _get(base_url, "/health")
    assert status == 200
    assert body == {"ok": True}


def test_products(base_url):
    status, body = _get(base_url, "/products")
    assert status == 200
    assert len(body["products"]) == 3


def test_predict(base_url):
    status, body = _post(base_url, "/predict", {"features": [1.0, 0.0, 0.0]})
    assert status == 200
    assert body["model"] == "v1"
    assert abs(body["y"] - 0.625) < 1e-9
