import { expect, test } from "@playwright/test";

const run = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Run", exact: true });
const reset = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Reset run" });

test.beforeEach(async ({ request }) => {
  await request.delete("/api/run");
});

// Leave no finished run behind: bun run preflight fails on one, and a rehearsal would start from it.
test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const res = await api.delete("/api/run");
    expect(res.status()).toBe(200);
  } finally {
    await api.dispose();
  }
});

test("clicking Run ends with nine Done rows, the $25,000 value visible, and the All set summary", async ({ page }) => {
  await page.goto("/people/onboarding/maya-torres");
  await expect(run(page)).toBeEnabled();
  await expect(page.getByText("Done", { exact: true })).toHaveCount(0);

  await run(page).click();
  await expect(run(page)).toBeDisabled(); // while the run is active
  await expect(page.getByText("Done", { exact: true })).toHaveCount(9, { timeout: 30_000 });
  await expect(page.getByText("$25,000 / month")).toBeVisible();
  await expect(page.getByTestId("run-summary")).toContainText(/All set in \d+ seconds?/);
  await expect(page.getByTestId("run-summary")).toContainText("9 of 9 steps finished. Nobody had to touch a thing.");
  await expect(run(page)).toBeDisabled(); // after finish, until reset

  await reset(page).click();
  await expect(run(page)).toBeEnabled();
  await expect(page.getByText("Done", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("run-summary")).toHaveCount(0);
});

test("the Permissions page is the static stub", async ({ page }) => {
  await page.goto("/automation/permissions");
  await expect(page.getByRole("heading", { level: 1, name: "Permissions" })).toBeVisible();
  await expect(page.getByText("fernhill-automation key")).toHaveCount(3);
  await expect(page.getByText("All 46")).toHaveCount(3);
  await expect(page.getByText("Rules and approvals aren't built yet")).toBeVisible();
  await expect(page.getByText("TODO: audit log for SOC 2")).toBeVisible();
});

test("state-changing API calls from another origin are rejected", async ({ request }) => {
  const cross = await request.post("/api/run", { headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" } });
  expect(cross.status()).toBe(403);
  const foreign = await request.delete("/api/run", { headers: { Origin: "https://evil.test" } });
  expect(foreign.status()).toBe(403);
  const noOrigin = await request.delete("/api/run");
  expect(noOrigin.status()).toBe(200);
});

test("a reset from outside the tab clears a finished page and re-enables Run", async ({ page, request }) => {
  await page.goto("/people/onboarding/maya-torres");
  await run(page).click();
  await expect(page.getByText("Done", { exact: true })).toHaveCount(9, { timeout: 30_000 });
  await expect(run(page)).toBeDisabled();

  expect((await request.delete("/api/run")).status()).toBe(200);
  await expect(page.getByText("Done", { exact: true })).toHaveCount(0, { timeout: 5_000 });
  await expect(run(page)).toBeEnabled();
  await expect(page.getByTestId("run-summary")).toHaveCount(0);
});

test("a run started outside the tab appears on an idle page", async ({ page, request }) => {
  await page.goto("/people/onboarding/maya-torres");
  await expect(run(page)).toBeEnabled();

  expect((await request.post("/api/run")).status()).toBe(202);
  await expect(run(page)).toBeDisabled({ timeout: 5_000 });
  await expect(page.getByText("Done", { exact: true })).toHaveCount(9, { timeout: 30_000 });
  await expect(page.getByTestId("run-summary")).toContainText("All set");
});
