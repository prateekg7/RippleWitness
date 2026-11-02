import { describe, expect, it } from "vitest";
import { roundMoney } from "./lib/money.js";
import { isReportsAuthorized, shippingFor } from "./app.js";
import { config } from "./config.js";

describe("shop-api helpers", () => {
  it("roundMoney rounds half up (UT helper for PR-04)", () => {
    expect(roundMoney(100.4)).toBe(100);
    expect(roundMoney(100.5)).toBe(101);
  });
  it("shipping is flat below threshold, free above", () => {
    expect(shippingFor(100)).toBe(500);
    expect(shippingFor(5000)).toBe(0);
  });
  it("reports auth accepts the configured bearer value, rejects the rest", () => {
    const good = ["Bearer", config.reportsToken].join(" ");
    expect(isReportsAuthorized(good)).toBe(true);
    expect(isReportsAuthorized(undefined)).toBe(false);
    expect(isReportsAuthorized("Bearer wrong")).toBe(false);
  });
});
