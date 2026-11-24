import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

// Real browser, real app, real local NobleCloak mock (a child process on its own port). The agent here is the
// ungoverned one, so the approvals are opened directly against the mock the way the adapter opens them.
const MOCK_PORT = Number(process.env.FERNHILL_E2E_MOCK_PORT ?? 8791);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const REF = (t: string) => `ext:fernhill-desk:${t}`;
let mock: ChildProcess;

test.beforeAll(async () => {
  mock = spawn("bun", ["scripts/noblecloak-local.ts"], { env: { ...process.env, NC_LOCAL_PORT: String(MOCK_PORT) }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mock did not start")), 20_000);
    mock.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("Tokens:")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
});
test.afterAll(() => {
  mock.kill();
});

async function nc(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(MOCK + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await r.json()) as any;
}

async function openApprovals() {
  const { creator } = (await (await fetch(`${MOCK}/__mock/tokens`)).json()) as Record<string, string>;
  const args = {
    adp_create_employee: { employee: "Maya Torres", title: "Marketing Coordinator", salary_source: "copied from Dana Whitfield" },
    mercury_issue_card: { cardholder: "Maya Torres", limit_monthly: 25000, copied_from: "Dana Whitfield", account: "Mercury Ops ••4471" },
  };
  for (const [tool, a] of Object.entries(args)) {
    await nc(creator, "POST", "/v1/tools", { tool_ref: REF(tool), description: tool, input_schema: { type: "object" }, side_effect_level: "external", transport: "external", owner_kind: "org", show_arguments_to_approvers: true });
    await nc(creator, "POST", "/v1/decisions", { action: { tool_ref: REF(tool), arguments: a }, actor: {}, continuation: { kind: "langgraph", delivery: "pull", correlation: { thread_id: "e2e" } } });
  }
}

test("two approvals appear for the current run; Priya approves payroll, then Sam denies the card with a reason", async ({ page, request }) => {
  await request.delete("/api/run");
  await request.post("/api/persona", { data: { persona: "priya" } });
  await page.goto("/people/onboarding/maya-torres");
  await expect(page.getByTestId("approval-panel")).toHaveCount(0); // dormant until approvals exist

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Done", { exact: true })).toHaveCount(9, { timeout: 30_000 });
  await openApprovals();
  // The page stops polling once a run is finished with nothing pending, so reading afresh is what finds them.
  await page.reload();

  const panel = page.getByTestId("approval-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const card = panel.locator('[data-tool="mercury_issue_card"]');
  const pay = panel.locator('[data-tool="adp_create_employee"]');
  await expect(card).toContainText("$25,000 / month");
  await expect(card).toContainText("Dana Whitfield");
  await expect(card).toContainText("Waiting for Finance");
  await expect(pay).toContainText("Waiting for HR");
  await expect(page.getByTestId("persona-switch")).toContainText("Priya Shah");

  await pay.getByRole("button", { name: "Approve" }).click();
  await expect(pay).toContainText("Approved by Priya Shah");

  await page.getByTestId("persona-switch").click();
  await expect(page.getByTestId("persona-switch")).toContainText("Sam Okoye");
  await card.getByLabel("Reason if denying").fill("Not this month");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(card).toContainText("Denied by Sam Okoye: Not this month");

  // Nothing token-shaped reached the page.
  expect(await page.content()).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  await request.delete("/api/run");
  await expect(page.getByTestId("approval-panel")).toHaveCount(0);
});

test("a run started after the approvals were opened does not show them", async ({ page, request }) => {
  await request.delete("/api/run");
  await page.goto("/people/onboarding/maya-torres");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Done", { exact: true })).toHaveCount(9, { timeout: 30_000 });
  await expect(page.getByTestId("approval-panel")).toHaveCount(0);
  await request.delete("/api/run");
});
