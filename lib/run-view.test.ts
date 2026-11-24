import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { ApprovalsError, type ApprovalView } from "./approvals";
import { firstPaint, forPage, withCallerDecisions } from "./run-view";
import type { Run } from "../src/run/types";

const run: Run = {
  id: "r",
  startedAt: "2026-11-03T10:00:00.000Z",
  state: "parked",
  steps: [{ tool: "mercury_issue_card", status: "denied", approvalId: "ap", reason: "Not this month", decidedBy: "Sam Okoye", resolution: "rejected" }],
};

describe("forPage", () => {
  it("mock mode: the run as it is", () => expect(forPage(run, "mock")).toBe(run));
  it("deployment mode: no decision detail, because the page is rendered for whoever asks, signed in or not", () => {
    const out = forPage(run, "deployment");
    expect(out.steps[0]).toEqual({ tool: "mercury_issue_card", status: "denied", approvalId: "ap" });
    expect(out.state).toBe("parked");
  });
});

describe("firstPaint", () => {
  it("mock mode: the run as it is", () => expect(firstPaint(run, "mock")).toBe(run));
  it("deployment mode: an idle skeleton, nothing from the stored run (no id, args, detail or approval id)", () => {
    const stored: Run = {
      ...run,
      id: "run-SENTINEL", steps: [{ tool: "mercury_issue_card", status: "waiting", approvalId: "appr-SENTINEL", args: { note: "arg-SENTINEL" }, detail: "detail-SENTINEL" }],
    };
    const out = firstPaint(stored, "deployment");
    expect(out).toEqual({ id: "", startedAt: "", state: "idle", steps: out.steps });
    expect(out.steps.every((s) => Object.keys(s).sort().join() === "status,tool" && s.status === "pending")).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/SENTINEL|2026-11-03/);
  });
  it("the onboarding page renders through it", () => {
    const src = readFileSync(new URL("../app/people/onboarding/maya-torres/page.tsx", import.meta.url), "utf8");
    expect(src).toContain("initialRun={firstPaint(getRun(), currentMode())}");
  });
});

describe("withCallerDecisions", () => {
  const view = (decision?: ApprovalView["decision"]): ApprovalView => ({ id: "ap", tool: "mercury_issue_card", args: {}, waitingOn: "finance", canDecide: true, actionDigest: "d", state: "rejected", ...(decision ? { decision } : {}) });
  const decided = { resolution: "rejected" as const, by: "Sam Okoye", reason: "Not this month", at: "2026-11-03T10:01:00.000Z" };
  const deps = { mode: "deployment" as const, bearer: "b" };

  it("a token that can read the approval gets who decided and why", async () => {
    const out = await withCallerDecisions(run, deps, async () => view(decided));
    expect(out.steps[0]).toMatchObject({ decidedBy: "Sam Okoye", resolution: "rejected", reason: "Not this month" });
  });
  it("the stored decision is not served to a token whose own read is refused or finds nothing", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const read of [async () => { throw new ApprovalsError(403, "no"); }, async () => null, async () => view()]) {
      const out = await withCallerDecisions(run, deps, read);
      expect(out.steps[0]).toEqual({ tool: "mercury_issue_card", status: "denied", approvalId: "ap" });
    }
    quiet.mockRestore();
  });
  it("a step without an approval is read for nothing", async () => {
    const read = vi.fn();
    const plain: Run = { ...run, steps: [{ tool: "mercury_issue_card", status: "done" }] };
    expect((await withCallerDecisions(plain, deps, read)).steps).toEqual(plain.steps);
    expect(read).not.toHaveBeenCalled();
  });
});
