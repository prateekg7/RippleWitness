import type { Db } from "./db.js";
import { bus } from "./lib/bus.js";

/** Reports maintains sales_summary via the in-process string-keyed event bus. */
export function registerReports(db: Db): void {
  bus.on("order.completed", (payload) => {
    db.prepare(
      "UPDATE sales_summary SET total_cents = total_cents + ?, orders_count = orders_count + 1 WHERE id = 1",
    ).run(payload.total);
  });
  // Promotional adjustment channel. Dormant in base: nothing emits
  // "discount.applied" yet (see PR-00). The static extractor deliberately
  // does not resolve string-keyed dispatch, so when checkout starts
  // emitting this event, /reports/sales changes become SURPRISE.
  bus.on("discount.applied", (payload) => {
    db.prepare("UPDATE sales_summary SET total_cents = total_cents - ? WHERE id = 1").run(
      payload.discount ?? 0,
    );
  });
}
