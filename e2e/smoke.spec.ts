import { expect, test } from "@playwright/test";
import { analyze, buildSubject, waitStatus } from "./fixtures";

const API = "http://127.0.0.1:4400";

test("E2E-01 happy path: analyze → predict → lock → reveal → ask → receipt", async ({ page }) => {
  const s = await buildSubject();
  await page.goto("/");
  await page.getByPlaceholder("/path/to/subject-repo").fill(s.repoPath);
  await page.getByPlaceholder("/path/to/demo/scenarios").fill(s.scenariosDir);
  await page.getByText("Advanced (app dir, seed DB, start command)").click();
  await page.getByPlaceholder("seed/seed.db").fill("seed.db");
  // baseRef defaults to main; headRef defaults to HEAD; start from package.json.
  await page.getByRole("button", { name: "Analyze" }).click();
  await page.waitForURL(/#\/runs\/.+/, { timeout: 30000 });
  await expect(page.getByRole("heading", { name: /Blast map/ })).toBeVisible({ timeout: 180000 });
  await expect(page.getByText("route:GET /value")).toBeVisible();
  // Predict the change, lock, reveal.
  await page.locator('input[type="checkbox"]').first().check();
  await page.getByRole("button", { name: "Lock prediction" }).click();
  await expect(page.getByRole("heading", { name: "Gate score" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/recall 1\.00/)).toBeVisible();
  // Cross-exam via the mock session (NO-LLM: records ASKED).
  const askButtons = page.getByRole("button", { name: "Ask agent" });
  expect(await askButtons.count()).toBeGreaterThan(0);
  await askButtons.first().click();
  await expect(page.getByText("(ASKED)")).toBeVisible({ timeout: 30000 });
  // Receipt.
  await page.getByRole("button", { name: "Issue receipt" }).click();
  await expect(page.getByText(/RippleWitness-Receipt:/)).toBeVisible({ timeout: 30000 });
});

test("E2E-02 pre-lock responses carry no observed data", async ({ page }) => {
  const s = await buildSubject();
  const runId = await analyze(API, s, { appStart: ["node", "server.js"], flakeGuard: false });
  await waitStatus(API, runId, ["ready"]);
  const payloads: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes(`/api/runs/${runId}/`)) {
      void r.text().then((t) => payloads.push(t)).catch(() => {});
    }
  });
  await page.goto(`/#/runs/${runId}`);
  await expect(page.getByRole("heading", { name: /Blast map/ })).toBeVisible({ timeout: 60000 });
  await page.waitForTimeout(1000);
  const joined = payloads.join("\n");
  expect(joined).not.toContain("observedChanged");
  expect(joined).not.toContain("SURPRISE");
  expect(joined).not.toContain("CONFIRMED");
  expect(joined).not.toContain("MISSED");
});

test("E2E-03 broken replay shows STATIC-ONLY with the gate disabled", async ({ page }) => {
  const s = await buildSubject();
  const runId = await analyze(API, s, { appStart: ["node", "missing.js"], flakeGuard: false });
  await waitStatus(API, runId, ["static-only"]);
  await page.goto(`/#/runs/${runId}`);
  await expect(page.getByText("Static only")).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "Lock prediction" })).toHaveCount(0);
});

test("E2E-04 NO-LLM: map and gate work, model usage says so", async ({ page }) => {
  const s = await buildSubject();
  const runId = await analyze(API, s, { appStart: ["node", "server.js"], flakeGuard: false });
  await waitStatus(API, runId, ["ready"]);
  await page.goto(`/#/runs/${runId}`);
  await expect(page.getByText("route:GET /value")).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Lock prediction" }).click();
  await expect(page.getByRole("heading", { name: "Gate score" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/NO-LLM: no model calls/)).toBeVisible();
});

test("E2E-05 split/stacked toggle shows the same content", async ({ page }) => {
  const s = await buildSubject();
  const runId = await analyze(API, s, { appStart: ["node", "server.js"], flakeGuard: false });
  await waitStatus(API, runId, ["ready"]);
  await page.goto(`/#/runs/${runId}`);
  await expect(page.getByText("helper.js").first()).toBeVisible({ timeout: 60000 });
  const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
  const stacked = norm((await page.locator("div.diff").first().textContent()) ?? "");
  expect(stacked).toContain("return");
  await page.getByRole("button", { name: "Split view" }).click();
  const split = norm((await page.locator("table.diff-split").first().textContent()) ?? "");
  for (const token of ['"base"', '"head"', "return"]) expect(split).toContain(token);
  expect(split.length).toBeGreaterThan(stacked.length / 3);
  await page.getByRole("button", { name: "Stacked view" }).click();
  await expect(page.locator("div.diff").first()).toContainText("return");
});
