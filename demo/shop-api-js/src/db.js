import Database from "better-sqlite3";

export function openDb(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory (sku TEXT PRIMARY KEY, stock INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, is_vip INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS carts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cart_items (cart_id TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, total_cents INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sales_summary (id INTEGER PRIMARY KEY CHECK (id = 1), total_cents INTEGER NOT NULL, orders_count INTEGER NOT NULL);
  `);
  const count = db.prepare("SELECT COUNT(*) AS n FROM products").get();
  if (count.n === 0) seed(db);
  return db;
}

export function seed(db) {
  const insP = db.prepare("INSERT OR IGNORE INTO products (sku, name, price_cents) VALUES (?, ?, ?)");
  insP.run("SKU-1", "Widget", 500);
  insP.run("SKU-2", "Gadget", 1500);
  insP.run("SKU-3", "Cable", 250);
  const insI = db.prepare("INSERT OR IGNORE INTO inventory (sku, stock) VALUES (?, ?)");
  insI.run("SKU-1", 100);
  insI.run("SKU-2", 50);
  insI.run("SKU-3", 200);
  const insU = db.prepare("INSERT OR IGNORE INTO users (id, is_vip) VALUES (?, ?)");
  insU.run("vip-1", 1);
  insU.run("regular-1", 0);
  db.prepare("INSERT OR IGNORE INTO sales_summary (id, total_cents, orders_count) VALUES (1, 0, 0)").run();
}
