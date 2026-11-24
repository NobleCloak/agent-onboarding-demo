import { describe, expect, it } from "vitest";
import type { Run, StepStatus, ToolName } from "../src/run/types";
import { TOOL_NAMES } from "../src/run/types";
import { STEP_META, summarize } from "./steps";

const make = (over: Partial<Record<ToolName, StepStatus>> = {}, base: StepStatus = "done"): Run => ({
  id: "r",
  startedAt: "x",
  state: "finished",
  steps: TOOL_NAMES.map((tool) => ({ tool, status: over[tool] ?? base })),
});

describe("STEP_META", () => {
  it("covers all nine tools with the three groups", () => {
    expect(Object.keys(STEP_META)).toHaveLength(9);
    expect(new Set(Object.values(STEP_META).map((m) => m.group))).toEqual(
      new Set(["Accounts", "On the way to her desk", "Money and access"]),
    );
  });
});

describe("summarize", () => {
  it("claims All set only when all nine are done", () => {
    expect(summarize(make(), 14)).toMatchObject({
      tone: "ok",
      title: "All set in 14 seconds",
      body: "9 of 9 steps finished. Nobody had to touch a thing.",
    });
  });
  it("drops the duration when it was not observed", () => {
    expect(summarize(make(), null)?.title).toBe("All set");
    expect(summarize(make(), 1)?.title).toBe("All set in 1 second");
  });
  it("counts what actually happened, from statuses", () => {
    const s = summarize(make({ adp_create_employee: "waiting", mercury_issue_card: "waiting", okta_assign_admin_role: "denied" }), 9);
    expect(s?.title).not.toMatch(/All set/);
    expect(s?.body).toBe("6 finished, 2 waiting on people, 1 not allowed");
    expect(s?.tone).toBe("warn");
  });
  it("a governed run where people approved never says nobody had to touch a thing", () => {
    const run = make();
    run.steps.find((s) => s.tool === "adp_create_employee")!.approvalId = "a";
    run.steps.find((s) => s.tool === "mercury_issue_card")!.approvalId = "b";
    const s = summarize(run, 9);
    expect(s?.body).toBe("9 of 9 steps finished. 2 approved by a person.");
    expect(s?.body).not.toMatch(/Nobody/);
  });
  it("the parked governed run says who it is waiting on", () => {
    const s = summarize(make({ adp_create_employee: "waiting", mercury_issue_card: "waiting", okta_assign_admin_role: "denied" }), null);
    expect(s?.title).toBe("Waiting on people");
  });
  it("after the decisions it counts a person's refusal apart from a rule's, and never claims All set", () => {
    const run = make({ mercury_issue_card: "denied", okta_assign_admin_role: "denied" });
    Object.assign(run.steps.find((s) => s.tool === "mercury_issue_card")!, { decidedBy: "Sam Okoye", reason: "Not this month" });
    const s = summarize(run, 9);
    expect(s).toMatchObject({ tone: "warn", title: "Finished with exceptions", body: "7 finished, 1 not allowed, 1 denied by a person" });
    expect(s?.body).not.toMatch(/Nobody/);
  });
  it("says a failed step failed", () => {
    const s = summarize(make({ cdw_order_laptop: "failed" }), 9);
    expect(s?.body).toBe("8 finished, 1 failed");
    expect(s?.tone).toBe("bad");
  });
  it("a run whose state says finished but has a skipped step is not All set", () => {
    expect(summarize(make({ mercury_issue_card: "skipped" }), 9)?.body).toBe("8 finished, 1 skipped");
  });
  it("is in progress while steps are pending, and null before anything has happened", () => {
    expect(summarize(make({}, "pending"), null)).toBeNull();
    const s = summarize(make({ okta_create_user: "done" }, "pending"), null);
    expect(s?.title).toBe("In progress");
    expect(s?.body).toBe("1 finished, 8 still to go");
  });
});
