"""Shared service fixture: db + config + depth chain."""
import os
import sqlite3

DB = sqlite3.connect(":memory:")


def list_items(sku):
    rows = DB.execute("SELECT * FROM products WHERE sku = ?", (sku,)).fetchall()
    return {"rows": rows, "limit": os.getenv("PAGE_LIMIT", "10")}


def charge():
    return deep()


def deep():
    return deeper()


def deeper():
    return level4()


def level4():
    return None
