import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harToScenarios, loadScenarios, writeHarScenarios } from "./index.js";

function har() {
  return {
    log: {
      entries: [
        {
          request: {
            method: "get",
            url: "http://127.0.0.1:4401/products?sort=price",
            headers: [
              { name: "Authorization", value: "Bearer secret" },
              { name: "Cookie", value: "sid=abc" },
              { name: "Content-Type", value: "application/json" },
            ],
          },
          response: { status: 200 },
        },
        {
          request: {
            method: "POST",
            url: "http://127.0.0.1:4401/cart",
            headers: [{ name: "content-type", value: "application/json" }],
            postData: { mimeType: "application/json", text: '{"sku":"SKU-1","qty":2}' },
          },
          response: { status: 201 },
        },
        {
          request: { method: "GET", url: "http://127.0.0.1:4401/boom", headers: [] },
          response: { status: 500 },
        },
        {
          request: { method: "GET", url: "http://other.test/x", headers: [] },
          response: { status: 200 },
        },
      ],
    },
  };
}

describe("HAR import (M-10)", () => {
  it("CT-HAR-01: converts entries, strips secrets, skips errors and foreign origins", () => {
    const scenarios = harToScenarios(har(), { baseUrl: "http://127.0.0.1:4401" });
    expect(scenarios).toHaveLength(2);
    const [get, post] = scenarios;
    expect(get?.id).toBe("har-1-get-products");
    expect(get?.routeIds).toEqual(["route:GET /products"]);
    expect(get?.steps[0]).toEqual({
      method: "GET",
      path: "/products?sort=price",
      headers: { "content-type": "application/json" },
    });
    // Authorization and Cookie never survive the import.
    expect(JSON.stringify(get)).not.toContain("secret");
    expect(JSON.stringify(get)).not.toContain("sid=abc");
    expect(post?.steps[0]?.body).toEqual({ sku: "SKU-1", qty: 2 });
  });

  it("CT-HAR-02: written files load as replay scenarios; malformed HAR fails typed", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-har-"));
    const written = writeHarScenarios(har(), dir, { baseUrl: "http://127.0.0.1:4401", includeErrors: true });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.files).toHaveLength(3);
    const loaded = loadScenarios(dir);
    expect(loaded.map((s) => s.id).sort()).toEqual(["har-1-get-products", "har-2-post-cart", "har-3-get-boom"]);
    expect(writeHarScenarios({ nope: 1 }, dir)).toEqual({ ok: false, error: expect.any(String) });
  });
});
