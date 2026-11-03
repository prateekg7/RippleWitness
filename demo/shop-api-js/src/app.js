import express from "express";
import { openDb } from "./db.js";
import { config } from "./config.js";
import { roundMoney } from "./lib/money.js";
import { createIdGen } from "./lib/ids.js";
import { now } from "./lib/clock.js";
import { bus } from "./lib/bus.js";
import { chargeExternal } from "./lib/external.js";
import { registerReports } from "./reports.js";

export function cartSubtotal(db, cartId) {
  const rows = db
    .prepare(
      "SELECT ci.qty, p.price_cents FROM cart_items ci JOIN products p ON p.sku = ci.sku WHERE ci.cart_id = ?",
    )
    .all(cartId);
  return rows.reduce((sum, r) => sum + r.qty * r.price_cents, 0);
}

export function shippingFor(subtotalCents) {
  return subtotalCents >= config.freeShippingThresholdCents ? 0 : config.shippingFlatCents;
}

export function isReportsAuthorized(authHeader) {
  return authHeader === `Bearer ${config.reportsToken}`;
}

export function createApp(dbPath = process.env.DB_PATH ?? ":memory:") {
  const db = openDb(dbPath);
  const nextId = createIdGen();
  bus.reset();
  registerReports(db);
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/__routes", (_req, res) => {
    if ((process.env.EXTERNAL_MODE ?? "mock") !== "mock") return res.status(404).json({ error: "not_found" });
    return res.json({ routes: ROUTES });
  });
  app.get("/products", (_req, res) => {
    const rows = db.prepare("SELECT sku, name, price_cents FROM products ORDER BY sku").all();
    res.json({ products: rows });
  });
  app.get("/products/:sku", (req, res) => {
    const row = db.prepare("SELECT sku, name, price_cents FROM products WHERE sku = ?").get(req.params.sku);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json(row);
  });
  app.post("/cart", (req, res) => {
    const body = req.body;
    const id = nextId();
    db.prepare("INSERT INTO carts (id, user_id) VALUES (?, ?)").run(id, body.user ?? "regular-1");
    const ins = db.prepare("INSERT INTO cart_items (cart_id, sku, qty) VALUES (?, ?, ?)");
    for (const item of body.items ?? []) ins.run(id, item.sku, item.qty);
    res.status(201).json({ id, user: body.user ?? "regular-1", items: body.items ?? [] });
  });
  app.get("/cart/:id", (req, res) => {
    const cart = db.prepare("SELECT id, user_id FROM carts WHERE id = ?").get(req.params.id);
    if (!cart) return res.status(404).json({ error: "not_found" });
    const items = db.prepare("SELECT sku, qty FROM cart_items WHERE cart_id = ? ORDER BY sku").all(cart.id);
    return res.json({ id: cart.id, user: cart.user_id, items, subtotal: cartSubtotal(db, cart.id) });
  });
  app.post("/checkout", (req, res) => {
    const body = req.body;
    const cartId = body.cartId ?? "";
    const cart = db.prepare("SELECT id FROM carts WHERE id = ?").get(cartId);
    if (!cart) return res.status(404).json({ error: "cart_not_found" });
    const subtotal = cartSubtotal(db, cartId);
    const shipping = shippingFor(subtotal);
    const total = roundMoney(subtotal + shipping);
    const orderId = nextId();
    db.prepare("INSERT INTO orders (id, user_id, total_cents, created_at) VALUES (?, ?, ?, ?)").run(
      orderId,
      body.user ?? "regular-1",
      total,
      now(),
    );
    bus.emit("order.completed", { total, orderId });
    return res.status(201).json({ orderId, subtotal, shipping, total });
  });
  app.get("/orders", (_req, res) => {
    const rows = db.prepare("SELECT id, user_id, total_cents, created_at FROM orders ORDER BY id").all();
    res.json({ orders: rows });
  });
  app.get("/orders/:id", (req, res) => {
    const row = db.prepare("SELECT id, user_id, total_cents, created_at FROM orders WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json(row);
  });
  app.get("/shipping/quote", (req, res) => {
    const subtotal = Number(req.query.subtotal ?? 0);
    res.json({ subtotal, shipping: shippingFor(subtotal) });
  });
  app.get("/inventory/:sku", (req, res) => {
    const row = db.prepare("SELECT sku, stock FROM inventory WHERE sku = ?").get(req.params.sku);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json(row);
  });
  app.get("/reports/sales", (req, res) => {
    if (!isReportsAuthorized(req.headers.authorization)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const row = db.prepare("SELECT total_cents, orders_count FROM sales_summary WHERE id = 1").get();
    return res.json({ total: row.total_cents, orders: row.orders_count });
  });
  app.post("/payments/charge", (req, res) => {
    const body = req.body;
    const result = chargeExternal(body.amount ?? 0);
    res.status(201).json(result);
  });
  return app;
}

export const ROUTES = [
  "route:GET /health",
  "route:GET /products",
  "route:GET /products/:sku",
  "route:POST /cart",
  "route:GET /cart/:id",
  "route:POST /checkout",
  "route:GET /orders",
  "route:GET /orders/:id",
  "route:GET /shipping/quote",
  "route:GET /inventory/:sku",
  "route:GET /reports/sales",
  "route:POST /payments/charge",
];
