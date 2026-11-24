import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { approveRules, nc, proposeRules, startMock, startWorker, stop, tokens } from "./governed-helpers";

// The Permissions page against a real local mock, started fresh for each test on the port the app is pointed at.
// Before the rules exist, or with no mock at all, the page is the static stub. After they are approved it is
// NobleCloak's own Permissions module. The last test needs the governed agent and skips where it is not installed.

const TOOLS = [
  "okta_create_user", "google_create_account", "slack_invite", "cdw_order_laptop", "merch_order_polos",
  "print_order_business_cards", "adp_create_employee", "mercury_issue_card", "okta_assign_admin_role",
];
const JWT = /eyJ[A-Za-z0-9_-]{10,}/;
const INSTALLED = existsSync("src/noblecloak/governed-agent.ts");

let mock: ChildProcess | undefined;
let worker: ChildProcess | undefined;
const stopAll = async () => {
  await stop(worker);
  await stop(mock);
  worker = mock = undefined;
};
test.afterEach(stopAll);

function watch(page: Page): () => string[] {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  return () => problems;
}

const stubShown = async (page: Page) => {
  await expect(page.getByText("Rules and approvals aren't built yet")).toBeVisible();
  await expect(page.getByTestId("permissions-module")).toHaveCount(0);
};

test("with no NobleCloak running the page is the stub, with no errors and no calls to the pass-through", async ({ page }) => {
  const problems = watch(page);
  const calls: string[] = [];
  page.on("request", (r) => r.url().includes("/api/nc") && calls.push(r.url()));
  await page.goto("/automation/permissions");
  await stubShown(page);
  await expect(page.getByText("Local NobleCloak")).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(problems()).toEqual([]);
});

test("a fresh mock, and a proposal nobody has approved yet, still show the stub; approving switches it with no restart", async ({ page }) => {
  mock = await startMock();
  const problems = watch(page);
  await page.goto("/automation/permissions");
  await stubShown(page);

  const proposal = await proposeRules();
  await page.reload();
  await stubShown(page);

  await approveRules(proposal);
  await page.reload();
  await expect(page.getByTestId("permissions-module")).toBeVisible();
  await expect(page.getByText("Rules and approvals aren't built yet")).toHaveCount(0);
  expect(problems()).toEqual([]);
});

test("retiring every rule keeps the module: the tools are still registered and the shim answers ask, so the stub would be wrong", async ({ page }) => {
  mock = await startMock();
  await approveRules(await proposeRules());
  const { admin } = await tokens();
  const list = await nc(admin, "GET", "/v1/policies?state=published&limit=200");
  const ours = (list.body.data as { id: string; targets?: { tools?: string[] } }[]).filter((p) => p.targets?.tools?.some((t) => t.startsWith("ext:fernhill-desk:")));
  expect(ours).toHaveLength(9);
  for (const p of ours) expect((await nc(admin, "POST", `/v1/policies/${p.id}/retire`)).status).toBe(200);
  const problems = watch(page);
  await page.goto("/automation/permissions");
  await expect(page.getByTestId("permissions-module")).toBeVisible();
  await expect(page.getByText("Rules and approvals aren't built yet")).toHaveCount(0);
  const table = page.getByRole("table", { name: /Tool policies by role/ });
  await expect(table.getByRole("rowheader", { name: "ext:fernhill-desk:slack_invite", exact: true })).toBeVisible();
  await expect(page.getByText("No policy").first()).toBeVisible();
  expect(problems()).toEqual([]);
});

test("once approved: all nine tools, an everyone column with their modes, a Local NobleCloak label, and no token anywhere", async ({ page, request }) => {
  mock = await startMock();
  await approveRules(await proposeRules());
  const problems = watch(page);
  const sent: (string | undefined)[] = [];
  page.on("request", (r) => r.url().includes("/api/nc") && sent.push(r.headers()["authorization"]));
  await page.goto("/automation/permissions");

  const table = page.getByRole("table", { name: /Tool policies by role/ });
  await expect(table).toBeVisible();
  const headers = await table.locator("thead th").allTextContents();
  expect(headers).toEqual(["Tool", "everyone", "Organisation (not used here)"]);
  const rows = table.locator("tbody tr").filter({ has: page.locator("th[scope=row]") });
  await expect(rows).toHaveCount(9);
  for (const tool of TOOLS) await expect(table.getByRole("rowheader", { name: `ext:fernhill-desk:${tool}`, exact: true })).toBeVisible();
  const mode = (tool: string) => table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: `ext:fernhill-desk:${tool}`, exact: true }) }).locator("td").first().locator(".nc-perm-mode");
  for (const t of ["okta_create_user", "slack_invite", "print_order_business_cards"]) await expect(mode(t)).toHaveText("Always allow");
  for (const t of ["adp_create_employee", "mercury_issue_card"]) await expect(mode(t)).toHaveText("Ask");
  await expect(mode("okta_assign_admin_role")).toHaveText("Deny");
  // The mock's own seeded tools and rules are not Fernhill's and are not shown.
  await expect(page.getByText("mcp:tracker")).toHaveCount(0);
  await expect(page.getByText("ext:local:send_email")).toHaveCount(0);

  await expect(page.getByTestId("local-label")).toHaveText("Local NobleCloak");
  await expect(page.getByText("Mock token")).toHaveCount(0);
  await expect(page.getByTestId("mock-banner")).toHaveCount(0);

  // The rules in the one unused column cannot be set from here: they would save and change nothing.
  const org = page.getByRole("combobox", { name: /for Organisation \(not used here\) on/ });
  await expect(org).toHaveCount(9);
  for (const select of await org.all()) await expect(select).toBeDisabled();

  // No token reaches the browser: not the page, not what the pass-through returns, not a header the browser sends.
  expect(await page.content()).not.toMatch(JWT);
  expect(sent.length).toBeGreaterThan(0);
  expect([...new Set(sent)]).toEqual(["Bearer local-demo-placeholder"]);
  const list = await request.get("/api/nc/v1/policies?limit=200", { headers: { authorization: "Bearer attacker-supplied" } });
  expect(list.status()).toBe(200);
  expect(await list.text()).not.toMatch(JWT);
  expect(JSON.stringify(list.headersArray())).not.toMatch(JWT);
  expect(problems()).toEqual([]);
});

test("the pass-through refuses the mock's token routes and approval resolution", async ({ request }) => {
  mock = await startMock();
  expect((await request.get("/api/nc/__mock/tokens")).status()).toBe(404);
  expect((await request.get("/api/nc/__demo/token?as=priya")).status()).toBe(404);
  expect((await request.post("/api/nc/v1/approvals/abc/resolve", { data: { resolution: "approved" } })).status()).toBe(404);
  expect((await request.post("/api/nc/v1/tools", { data: {} })).status()).toBe(404);
  expect((await request.post("/api/nc/v1/policies/x/publish", { headers: { "sec-fetch-site": "cross-site" } })).status()).toBe(403);
});

test("a request carrying another site's Host (DNS rebinding) is refused on the pass-through and the other API routes", async ({ request }) => {
  mock = await startMock();
  for (const path of ["/api/nc/v1/policies", "/api/approvals", "/api/run"]) {
    const res = await request.get(path, { headers: { host: "rebound.evil.test" } });
    expect(res.status(), path).toBe(403);
  }
  expect((await request.get("/api/nc/v1/policies", { headers: { "sec-fetch-site": "same-site" } })).status()).toBe(403);
  expect((await request.get("/api/nc/v1/policies")).status()).toBe(200);
});

test("an edit published in the page decides the next run: slack_invite set to ask waits for approval", async ({ page, request }) => {
  test.skip(!INSTALLED, "NobleCloak is not installed on this branch, so there is no governed agent to run");
  mock = await startMock();
  worker = await startWorker();
  await request.delete("/api/run");
  const problems = watch(page);

  // Approve the rules in the run page's panel, as the presenter does.
  await proposeRules();
  await page.goto("/people/onboarding/maya-torres");
  const panel = page.getByTestId("proposal-panel");
  await expect(panel).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
  await panel.getByRole("button", { name: "Approve rules" }).click();
  await expect(panel).toHaveAttribute("data-state", "approved", { timeout: 15_000 });

  // Change one rule in the Permissions page and publish it.
  await page.goto("/automation/permissions");
  const cell = page.getByRole("combobox", { name: /for everyone on ext:fernhill-desk:slack_invite$/ });
  await expect(cell).toHaveValue("always_allow");
  await cell.selectOption("ask");
  await expect(page.getByText("Draft pending v2").first()).toBeVisible();
  // The Drafts panel names its button after the policy: "Publish tool_invocation pol_...".
  await page.getByRole("button", { name: /^Publish tool_invocation/ }).click();
  await expect(page.getByText(/^Published v2\./).first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: /for everyone on ext:fernhill-desk:slack_invite$/ })).toHaveValue("ask");

  // The next run waits at that tool.
  await page.goto("/people/onboarding/maya-torres");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const row = page.locator('.row[data-tool="slack_invite"]');
  await expect(row).toHaveAttribute("data-status", "waiting", { timeout: 30_000 });
  await expect(row).toContainText("Waiting for approval");
  await expect(page.locator('.row[data-tool="okta_create_user"]')).toHaveAttribute("data-status", "done");
  expect(problems()).toEqual([]);
  await request.delete("/api/run");
});
