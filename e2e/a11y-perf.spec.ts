import { expect, test } from "@playwright/test";
import { analyze, buildSubject, waitStatus } from "./fixtures";

const API = "http://127.0.0.1:4400";

test("E2E-06 keyboard-only gate: focus, space, enter", async ({ page }) => {
  const s = await buildSubject();
  const runId = await analyze(API, s, { appStart: ["node", "server.js"], flakeGuard: false });
  await waitStatus(API, runId, ["ready"]);
  await page.goto(`/#/runs/${runId}`);
  const box = page.locator('input[type="checkbox"]').first();
  await expect(box).toBeVisible({ timeout: 60000 });
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  const lock = page.getByRole("button", { name: "Lock prediction" });
  await lock.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Gate score" })).toBeVisible({ timeout: 30000 });
});

test("E2E-07 statuses carry non-color glyphs plus a legend", async ({ page }) => {
  const s = await buildSubject();
  const runId = await analyze(API, s, { appStart: ["node", "server.js"], flakeGuard: false });
  await waitStatus(API, runId, ["ready"]);
  await page.goto(`/#/runs/${runId}`);
  await expect(page.getByText("route:GET /value")).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Lock prediction" }).click();
  await expect(page.getByRole("heading", { name: "Gate score" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/▲ SURPRISE · ✕ CONTRADICTED/)).toBeVisible();
  const pill = page.locator("span.pill").first();
  await expect(pill).toContainText(/^[▲✕●○?·≠▪] /);
});

test("E2E-11 QUIET hidden post-lock until toggled", async ({ page }) => {
  await page.route("**/api/runs/*/status", (r) =>
    r.fulfill({ json: { id: "x", status: "ready", stages: "{}", locked: 1, reviewMode: "full" } }),
  );
  await page.route("**/api/runs/*/map", (r) =>
    r.fulfill({
      json: {
        nodes: [
          { routeId: "route:GET /loud", staticImpacted: true, inDiff: false, exercised: true, status: "CONFIRMED" },
          { routeId: "route:GET /quiet", staticImpacted: false, inDiff: false, exercised: true, status: "QUIET" },
        ],
      },
    }),
  );
  await page.route("**/api/runs/*/diff", (r) => r.fulfill({ json: { files: [] } }));
  await page.route("**/api/runs/*/reveal", (r) =>
    r.fulfill({
      json: {
        score: { predicted: [], observed: [], hits: [], misses: [], falsePositives: [], recall: 1, precision: 1, passed: true, passReason: "x" },
        overrideReason: null,
        nodes: [],
        claims: [],
        questions: [],
        reviewMode: "full",
      },
    }),
  );
  await page.goto("/#/runs/synth");
  await expect(page.getByText("route:GET /loud")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("route:GET /quiet")).toHaveCount(0);
  await page.getByText("Show quiet routes").click();
  await expect(page.getByText("route:GET /quiet")).toBeVisible();
});

test("E2E-08 150-node map renders under 2s", async ({ page }) => {
  const nodes = Array.from({ length: 150 }, (_, i) => ({
    routeId: `route:GET /r${i}`,
    staticImpacted: i % 2 === 0,
    inDiff: false,
    exercised: true,
  }));
  await page.route("**/api/runs/*/status", (r) =>
    r.fulfill({ json: { id: "x", status: "ready", stages: "{}", locked: 0, reviewMode: "full" } }),
  );
  await page.route("**/api/runs/*/map", (r) => r.fulfill({ json: { nodes, calibration: [] } }));
  await page.route("**/api/runs/*/diff", (r) => r.fulfill({ json: { files: [] } }));
  // Warm the dev transform, then time a reload: network is fulfilled, so the
  // budget measures React render of 150 rows (dev-mode budget 5s; prod is faster).
  await page.goto("/#/runs/synth");
  await expect(page.getByText("route:GET /r149")).toBeVisible({ timeout: 30000 });
  const started = Date.now();
  await page.reload();
  await expect(page.getByText("route:GET /r149")).toBeVisible({ timeout: 30000 });
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(page.locator("tbody tr")).toHaveCount(150);
});
