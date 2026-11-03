"""Shop API (Python/Flask-pattern): mirrors the TS shop-api behavior."""

import os

import bus
from model import predict
from router import Blueprint, Flask, _HttpError
from store import open_db

REPORTS_TOKEN = "reports-token"
SHIPPING_FLAT = int(os.environ.get("SHIPPING_FLAT", "500"))
FREE_SHIPPING_THRESHOLD = 5000

_db = None
_id_n = [0]


def _db_conn():
    global _db
    if _db is None:
        _db = open_db()
    return _db


def _next_id():
    seed = os.environ.get("SEED", "42")
    _id_n[0] += 1
    return f"id-{seed}-{_id_n[0]}"


def _now():
    return os.environ.get("FROZEN_TIME", "2026-01-01T00:00:00Z")


def _row(r):
    return dict(r) if r is not None else None


def cart_subtotal(db, cart_id):
    rows = db.execute(
        "SELECT ci.qty, p.price_cents FROM cart_items ci "
        "JOIN products p ON p.sku = ci.sku WHERE ci.cart_id = ?",
        (cart_id,),
    ).fetchall()
    return sum(r["qty"] * r["price_cents"] for r in rows)


def shipping_for(subtotal):
    return 0 if subtotal >= FREE_SHIPPING_THRESHOLD else SHIPPING_FLAT


def _register_reports(db):
    def on_order(payload):
        db.execute(
            "UPDATE sales_summary SET total_cents = total_cents + ?, "
            "orders_count = orders_count + 1 WHERE id = 1",
            (payload["total"],),
        )
        db.commit()

    def on_discount(payload):
        db.execute(
            "UPDATE sales_summary SET total_cents = total_cents - ? WHERE id = 1",
            (payload.get("discount", 0),),
        )
        db.commit()

    bus.on("order.completed", on_order)
    # Dormant promotional channel (see PR-PY-00): nothing emits
    # "discount.applied" in base. String-keyed dispatch is invisible to the
    # static extractor, so the ripple becomes SURPRISE.
    bus.on("discount.applied", on_discount)


app = Flask(__name__)
bp = Blueprint("shop", __name__, url_prefix="/v1")


@app.route("/health", methods=["GET"])
def health(req, params, query):
    return 200, {"ok": True}


@app.route("/__routes", methods=["GET"])
def routes_list(req, params, query):
    if os.environ.get("EXTERNAL_MODE", "mock") != "mock":
        raise _HttpError(404, "not_found")
    return 200, {"routes": ROUTES}


@app.route("/products", methods=["GET"])
def products(req, params, query):
    rows = _db_conn().execute("SELECT sku, name, price_cents FROM products ORDER BY sku").fetchall()
    return 200, {"products": [_row(r) for r in rows]}


@app.route("/products/<sku>", methods=["GET"])
def product(req, params, query):
    row = _row(_db_conn().execute(
        "SELECT sku, name, price_cents FROM products WHERE sku = ?", (params["sku"],)
    ).fetchone())
    if row is None:
        raise _HttpError(404, "not_found")
    return 200, row


@app.route("/cart", methods=["POST"])
def create_cart(req, params, query):
    body = req._body()
    cart_id = _next_id()
    db = _db_conn()
    db.execute("INSERT INTO carts (id, user_id) VALUES (?, ?)", (cart_id, body.get("user", "regular-1")))
    for item in body.get("items", []):
        db.execute(
            "INSERT INTO cart_items (cart_id, sku, qty) VALUES (?, ?, ?)",
            (cart_id, item["sku"], item["qty"]),
        )
    db.commit()
    return 201, {"id": cart_id, "user": body.get("user", "regular-1"), "items": body.get("items", [])}


@app.route("/cart/<id>", methods=["GET"])
def get_cart(req, params, query):
    db = _db_conn()
    cart = _row(db.execute("SELECT id, user_id FROM carts WHERE id = ?", (params["id"],)).fetchone())
    if cart is None:
        raise _HttpError(404, "not_found")
    items = [_row(r) for r in db.execute(
        "SELECT sku, qty FROM cart_items WHERE cart_id = ? ORDER BY sku", (cart["id"],)
    ).fetchall()]
    return 200, {"id": cart["id"], "user": cart["user_id"], "items": items, "subtotal": cart_subtotal(db, cart["id"])}


@app.route("/checkout", methods=["POST"])
def checkout(req, params, query):
    body = req._body()
    cart_id = body.get("cartId", "")
    db = _db_conn()
    cart = db.execute("SELECT id FROM carts WHERE id = ?", (cart_id,)).fetchone()
    if cart is None:
        raise _HttpError(404, "cart_not_found")
    subtotal = cart_subtotal(db, cart_id)
    shipping = shipping_for(subtotal)
    total = subtotal + shipping
    order_id = _next_id()
    db.execute(
        "INSERT INTO orders (id, user_id, total_cents, created_at) VALUES (?, ?, ?, ?)",
        (order_id, body.get("user", "regular-1"), total, _now()),
    )
    db.commit()
    bus.emit("order.completed", {"total": total, "orderId": order_id})
    return 201, {"orderId": order_id, "subtotal": subtotal, "shipping": shipping, "total": total}


@app.route("/orders", methods=["GET"])
def orders(req, params, query):
    rows = _db_conn().execute("SELECT id, user_id, total_cents, created_at FROM orders ORDER BY id").fetchall()
    return 200, {"orders": [_row(r) for r in rows]}


@app.route("/orders/<id>", methods=["GET"])
def order(req, params, query):
    row = _row(_db_conn().execute(
        "SELECT id, user_id, total_cents, created_at FROM orders WHERE id = ?", (params["id"],)
    ).fetchone())
    if row is None:
        raise _HttpError(404, "not_found")
    return 200, row


@app.route("/reports/sales", methods=["GET"])
def sales(req, params, query):
    auth = req.headers.get("authorization")
    if auth != f"Bearer {REPORTS_TOKEN}":
        raise _HttpError(401, "unauthorized")
    row = _db_conn().execute("SELECT total_cents, orders_count FROM sales_summary WHERE id = 1").fetchone()
    return 200, {"total": row["total_cents"], "orders": row["orders_count"]}


@app.route("/predict", methods=["POST"])
def predict_route(req, params, query):
    body = req._body()
    return 200, predict(body.get("features", []))


@app.route("/openapi.json", methods=["GET"])
def openapi(req, params, query):
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "openapi.json"), "r", encoding="utf-8") as fh:
        import json

        return 200, json.load(fh)


@bp.route("/ping", methods=["GET"])
def ping(req, params, query):
    return 200, {"pong": True}


app.register_blueprint(bp)
bus.reset()
_register_reports(_db_conn())

ROUTES = [
    "route:GET /health",
    "route:GET /products",
    "route:GET /products/:sku",
    "route:POST /cart",
    "route:GET /cart/:id",
    "route:POST /checkout",
    "route:GET /orders",
    "route:GET /orders/:id",
    "route:GET /reports/sales",
    "route:POST /predict",
    "route:GET /v1/ping",
]
