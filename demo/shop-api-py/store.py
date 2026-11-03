"""SQLite store: same schema and seed rows as the TS shop-api."""

import os
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inventory (sku TEXT PRIMARY KEY, stock INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, is_vip INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS carts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cart_items (cart_id TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, total_cents INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sales_summary (id INTEGER PRIMARY KEY CHECK (id = 1), total_cents INTEGER NOT NULL, orders_count INTEGER NOT NULL);
"""


def open_db(path=None):
    db_path = path or os.environ.get("DB_PATH", ":memory:")
    # ThreadingHTTPServer serves each request on its own thread while the app
    # holds one shared connection; replay issues requests sequentially, so
    # cross-thread use is safe here (and required for the threaded server).
    db = sqlite3.connect(db_path, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    n = db.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]
    if n == 0:
        seed(db)
    return db


def seed(db):
    db.executemany(
        "INSERT OR IGNORE INTO products (sku, name, price_cents) VALUES (?, ?, ?)",
        [("SKU-1", "Widget", 500), ("SKU-2", "Gadget", 1500), ("SKU-3", "Cable", 250)],
    )
    db.executemany(
        "INSERT OR IGNORE INTO inventory (sku, stock) VALUES (?, ?)",
        [("SKU-1", 100), ("SKU-2", 50), ("SKU-3", 200)],
    )
    db.executemany(
        "INSERT OR IGNORE INTO users (id, is_vip) VALUES (?, ?)",
        [("vip-1", 1), ("regular-1", 0)],
    )
    db.execute("INSERT OR IGNORE INTO sales_summary (id, total_cents, orders_count) VALUES (1, 0, 0)")
    db.commit()
