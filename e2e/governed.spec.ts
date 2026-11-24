import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { nc, proposeRules, setRule, startMock, startWorker, stop, tokens } from "./governed-helpers";

// Real browser, real app, the generated governance and the generated worker, on a real local mock. Only on a branch
// where NobleCloak is installed. Each test gets a fresh mock, so each proposes and approves its own rules.
test.skip(!existsSync("src/noblecloak/governed-agent.ts"), "NobleCloak is not installed on this branch");

const SIX = ["okta_create_user", "google_create_account", "slack_invite", "cdw_order_laptop", "merch_order_polos", "print_order_business_cards"];
const PAIR_RUNS = Number(process.env.FERNHILL_PAIR_RUNS ?? 1);

let mock: ChildProcess | undefined;
let worker: ChildProcess | undefined;

const row = (page: Page, tool: string) => page.locator(`.row[data-tool="${tool}"]`);
const panelCard = (page: Page, tool: string) => page.getByTestId("approval-panel").locator(`[data-tool="${tool}"]`);

async function runState(request: APIRequestContext) {
  return (await (await request.get("/api/run")).json()) as { id: string; state: string; steps: { tool: string; status: string; approvalId?: string; decidedBy?: string; reason?: string }[] };
}

async function approveRulesInPanel(page: Page) {
  const panel = page.getByTestId("proposal-panel");
  await expect(panel).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
  await expect(panel).toContainText("Runs freely (6)");
  await expect(panel).toContainText("Asks a person (2)");
  await expect(panel).toContainText("Never allowed (1)");
  await panel.getByRole("button", { name: "Approve rules" }).click();
  await expect(panel).toHaveAttribute("data-state", "approved", { timeout: 15_000 });
  await expect(panel).toContainText("Approved by Admin");
}

async function startRunToParked(page: Page) {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(row(page, "adp_create_employee")).toHaveAttribute("data-status", "waiting", { timeout: 30_000 });
  await expect(row(page, "mercury_issue_card")).toHaveAttribute("data-status", "waiting");
}

test.beforeEach(async ({ request }) => {
  mock = await startMock();
  worker = undefined;
  await request.delete("/api/run");
  await request.post("/api/persona", { data: { persona: "priya" } });
});

test.afterEach(async ({ request }) => {
  await request.delete("/api/run");
  await stop(worker);
  await stop(mock);
});

test("rules approved in the panel; six run, admin refused, payroll and card wait; Priya denies the card, Sam approves payroll", async ({ page, request }) => {
  worker = await startWorker();
  await proposeRules();
  await page.goto("/people/onboarding/maya-torres");
  await approveRulesInPanel(page);
  await startRunToParked(page);

  for (const tool of SIX) await expect(row(page, tool)).toHaveAttribute("data-status", "done");
  await expect(row(page, "okta_assign_admin_role")).toContainText("Not allowed");
  await expect(row(page, "adp_create_employee")).toContainText("Waiting for HR");
  await expect(row(page, "mercury_issue_card")).toContainText("Waiting for Finance");
  await expect(page.getByTestId("run-summary")).toContainText("6 finished, 2 waiting on people, 1 not allowed");

  // The match is exact: the steps name the approvals the panel shows.
  const parked = await runState(request);
  expect(parked.state).toBe("parked");
  const card = parked.steps.find((s) => s.tool === "mercury_issue_card")!;
  await expect(panelCard(page, "mercury_issue_card")).toHaveAttribute("data-approval", card.approvalId!);
  await expect(panelCard(page, "mercury_issue_card")).toContainText("$25,000 / month");
  await expect(panelCard(page, "adp_create_employee")).toContainText("Waiting for HR");
  // Priya is in Finance: payroll is not hers to decide, and its details are not shown to her.
  await expect(panelCard(page, "adp_create_employee").getByTestId("not-yours")).toHaveText("Only HR can decide this. Switch to Sam.");
  await expect(panelCard(page, "adp_create_employee").getByRole("button")).toHaveCount(0);
  await expect(panelCard(page, "adp_create_employee")).not.toContainText("Dana Whitfield");

  await panelCard(page, "mercury_issue_card").getByLabel("Reason if denying").fill("Not this month");
  await panelCard(page, "mercury_issue_card").getByRole("button", { name: "Deny" }).click();
  await expect(panelCard(page, "mercury_issue_card")).toContainText("Denied by Priya Shah: Not this month");

  await page.getByTestId("persona-switch").click();
  await expect(page.getByTestId("persona-switch")).toContainText("Sam Okoye");
  await panelCard(page, "adp_create_employee").getByRole("button", { name: "Approve" }).click();
  await expect(panelCard(page, "adp_create_employee")).toContainText("Approved by Sam Okoye");

  await expect(row(page, "adp_create_employee")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(row(page, "mercury_issue_card")).toHaveAttribute("data-status", "denied");
  await expect(row(page, "mercury_issue_card")).toContainText("Denied by Priya Shah");
  await expect(row(page, "mercury_issue_card")).toContainText("Not this month");
  await expect(page.getByTestId("run-summary")).toContainText("Finished with exceptions");
  await expect(page.getByTestId("run-summary")).toContainText("7 finished, 1 not allowed, 1 denied by a person");
  await expect(page.getByTestId("run-summary")).not.toContainText("Nobody");
  await expect.poll(async () => (await runState(request)).state).toBe("finished");
  expect(await page.content()).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
});

test("with no worker running the page says the approved call is waiting, and it runs once the worker starts", async ({ page, request }) => {
  await proposeRules();
  await page.goto("/people/onboarding/maya-torres");
  await approveRulesInPanel(page);
  await startRunToParked(page);

  // Payroll is HR's to decide, so Sam approves it.
  await page.getByTestId("persona-switch").click();
  await expect(page.getByTestId("persona-switch")).toContainText("Sam Okoye");
  await panelCard(page, "adp_create_employee").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("worker-waiting")).toContainText("Waiting for the worker", { timeout: 10_000 });
  await expect(row(page, "adp_create_employee")).toContainText("Approved by Sam Okoye, waiting to resume");
  expect((await runState(request)).state).toBe("parked");

  worker = await startWorker();
  await expect(row(page, "adp_create_employee")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(page.getByTestId("worker-waiting")).toHaveCount(0);
});

test("a rule change decides the next run: slack_invite set to ask waits on the page; restored, it runs again", async ({ page, request }) => {
  worker = await startWorker();
  await proposeRules();
  await page.goto("/people/onboarding/maya-torres");
  await approveRulesInPanel(page);

  await setRule("slack_invite", "ask");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(row(page, "slack_invite")).toHaveAttribute("data-status", "waiting", { timeout: 30_000 });
  await expect(row(page, "slack_invite")).toContainText("Waiting for approval");
  await expect(panelCard(page, "slack_invite")).toContainText("maya.torres@fernhill.co");
  await expect(row(page, "okta_create_user")).toHaveAttribute("data-status", "done");

  await panelCard(page, "slack_invite").getByRole("button", { name: "Approve" }).click();
  await expect(row(page, "slack_invite")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(row(page, "adp_create_employee")).toHaveAttribute("data-status", "waiting", { timeout: 20_000 });

  await setRule("slack_invite", "always_allow");
  const { creator } = await tokens();
  const decision = await nc(creator, "POST", "/v1/decisions", { action: { tool_ref: "ext:fernhill-desk:slack_invite", arguments: { email: "another@fernhill.co" } }, actor: {}, continuation: { kind: "langgraph", delivery: "pull", correlation: { thread_id: "check" } } });
  expect(decision.body.data.decision).toBe("allow");
  await request.delete("/api/run");
});

for (let n = 1; n <= PAIR_RUNS; n++) {
  test(`the pair decided at the same moment, through the app: run ${n} of ${PAIR_RUNS}`, async ({ page, request }) => {
    worker = await startWorker();
    await proposeRules();
    await page.goto("/people/onboarding/maya-torres");
    await approveRulesInPanel(page);
    await startRunToParked(page);
    const steps = (await runState(request)).steps;
    await expect(panelCard(page, "mercury_issue_card")).toBeVisible();
    const list = (await (await request.get("/api/approvals")).json()) as { approvals: { id: string; tool: string; actionDigest: string }[] };
    const pay = list.approvals.find((a) => a.tool === "adp_create_employee")!;
    const card = list.approvals.find((a) => a.tool === "mercury_issue_card")!;
    expect(steps.find((s) => s.tool === "adp_create_employee")?.approvalId).toBe(pay.id);

    const started = Date.now();
    const [a, b] = await Promise.all([
      request.post(`/api/approvals/${pay.id}/resolve`, { headers: { cookie: "fernhill_persona=sam" }, data: { decision: "approve", expectedActionDigest: pay.actionDigest } }),
      request.post(`/api/approvals/${card.id}/resolve`, { headers: { cookie: "fernhill_persona=priya" }, data: { decision: "deny", expectedActionDigest: card.actionDigest, reason: "Not this month" } }),
    ]);
    expect([a.status(), b.status()]).toEqual([200, 200]);

    await expect.poll(async () => (await runState(request)).state, { timeout: 20_000 }).toBe("finished");
    const finishMs = Date.now() - started;
    const end = await runState(request);
    expect(end.steps.find((s) => s.tool === "adp_create_employee")?.status).toBe("done");
    expect(end.steps.find((s) => s.tool === "mercury_issue_card")).toMatchObject({ status: "denied", decidedBy: "Priya Shah", reason: "Not this month" });
    console.log(`PAIR run ${n}: finished ${finishMs} ms after the decisions`);
  });
}
