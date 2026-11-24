import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "./reconcile";
import { closeStore, getRun, resetRun, setStep, startRun } from "./store";
import type { ToolName } from "./types";

// The shapes below were recorded from a real run of the app's agent with @noblecloak/langgraph 0.4.0 on the local mock.
const denial = (name: string, id: string, code: string, content: string) =>
  new ToolMessage({ name, tool_call_id: id, status: "error", content, additional_kwargs: { noblecloak: { code } } });
const ok = (name: string, id: string) => new ToolMessage({ name, tool_call_id: id, status: "success", content: "ok" });
const interrupt = (tool: string, approvalId: string, callId: string) => ({
  id: `i-${callId}`,
  value: { approval_id: approvalId, tool_ref: `ext:fernhill-desk:${tool}`, tool_call_id: callId, summary: `Approval required to run ext:fernhill-desk:${tool}.` },
});
const ADMIN_DENIED = denial("okta_assign_admin_role", "c9", "denied", "Governance denied this call (deny). The tool was not run.");
const PARKED = {
  messages: [new HumanMessage("Maya starts Monday"), new AIMessage({ content: "" }), ok("okta_create_user", "c1"), ADMIN_DENIED],
  __interrupt__: [interrupt("adp_create_employee", "ap-pay", "c7"), interrupt("mercury_issue_card", "ap-card", "c8")],
};

const step = (tool: ToolName) => getRun().steps.find((s) => s.tool === tool)!;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fernhill-reconcile-"));
  process.env.FERNHILL_DATA_DIR = dir;
});
afterEach(() => {
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
  vi.restoreAllMocks();
});

describe("reconcile", () => {
  it("an interrupt marks the matching step waiting with its approvalId", () => {
    const run = startRun()!;
    reconcile(PARKED, run.id);
    expect(step("adp_create_employee")).toMatchObject({ status: "waiting", approvalId: "ap-pay" });
    expect(step("mercury_issue_card")).toMatchObject({ status: "waiting", approvalId: "ap-card" });
  });

  it("a denied call marks the step denied with its reason", () => {
    const run = startRun()!;
    reconcile(PARKED, run.id);
    expect(step("okta_assign_admin_role")).toMatchObject({ status: "denied", reason: "Governance denied this call (deny). The tool was not run." });
  });

  it("an approver's rejection after a wait keeps the approvalId, so the decision can be read from the approval", () => {
    const run = startRun()!;
    reconcile(PARKED, run.id);
    reconcile({ messages: [denial("mercury_issue_card", "c8", "rejected", "The approver rejected this call: Not this month. The tool was not run.")] }, run.id);
    expect(step("mercury_issue_card")).toMatchObject({ status: "denied", approvalId: "ap-card" });
  });

  it("an approver's reason already read from the approval is not overwritten by the tool message's wording", () => {
    const run = startRun()!;
    setStep(run.id, "mercury_issue_card", { status: "waiting", approvalId: "ap-card", decidedBy: "Sam Okoye", resolution: "rejected", reason: "Not this month" });
    reconcile({ messages: [denial("mercury_issue_card", "c8", "rejected", "The approver rejected this call: Not this month. The tool was not run.")] }, run.id);
    expect(step("mercury_issue_card")).toMatchObject({ status: "denied", decidedBy: "Sam Okoye", reason: "Not this month" });
  });

  it("the rejected_duplicate wording is a denial too (decided at the same moment)", () => {
    const run = startRun()!;
    reconcile(PARKED, run.id);
    reconcile({ messages: [denial("mercury_issue_card", "c8", "denied", "Governance denied this call (rejected_duplicate). The tool was not run.")] }, run.id);
    expect(step("mercury_issue_card")).toMatchObject({ status: "denied", approvalId: "ap-card" });
  });

  it("an unresolved approval from an earlier run is ignored", async () => {
    const old = startRun()!;
    await resetRun();
    const current = startRun()!;
    reconcile(PARKED, old.id);
    expect(getRun().id).toBe(current.id);
    expect(getRun().steps.every((s) => s.status === "pending" && !s.approvalId)).toBe(true);
  });

  it("a governance error marks the step failed and the tool never runs", () => {
    const run = startRun()!;
    reconcile({ messages: [denial("mercury_issue_card", "c8", "unroutable", "Approval cannot be routed. The tool was not run.")] }, run.id);
    expect(step("mercury_issue_card")).toMatchObject({ status: "failed", reason: "Approval cannot be routed. The tool was not run." });
  });

  it("a tool that threw marks the step failed, not denied", () => {
    const run = startRun()!;
    reconcile({ messages: [new ToolMessage({ name: "slack_invite", tool_call_id: "c3", status: "error", content: "Error: boom" })] }, run.id);
    expect(step("slack_invite")).toMatchObject({ status: "failed", reason: "Error: boom" });
  });

  it("a call held back by another call's approval in the same task stays as it was", () => {
    const run = startRun()!;
    reconcile({ messages: [denial("slack_invite", "c3", "approval_pending_in_task", "Another call in this turn is waiting for approval.")] }, run.id);
    expect(step("slack_invite").status).toBe("pending");
  });

  it("is a no-op for a fully completed result", () => {
    const run = startRun()!;
    setStep(run.id, "okta_create_user", { status: "done", detail: "Account x" });
    const before = JSON.stringify(getRun());
    reconcile({ messages: [ok("okta_create_user", "c1"), new AIMessage("Maya Torres is set up.")] }, run.id);
    expect(JSON.stringify(getRun())).toBe(before);
  });

  it("a stale interrupt never moves a step that already ran back to waiting", () => {
    // After the worker resumes one call the checkpoint still lists that call's interrupt until the turn ends.
    const run = startRun()!;
    setStep(run.id, "adp_create_employee", { status: "done", approvalId: "ap-pay" });
    reconcile(PARKED, run.id);
    expect(step("adp_create_employee").status).toBe("done");
  });

  it("a denied step stays denied when the same interrupt is read again", () => {
    const run = startRun()!;
    reconcile({ messages: [denial("mercury_issue_card", "c8", "rejected", "rejected")] }, run.id);
    reconcile({ __interrupt__: [interrupt("mercury_issue_card", "ap-card", "c8")] }, run.id);
    expect(step("mercury_issue_card").status).toBe("denied");
  });

  it("ignores an interrupt or a message for a tool that is not one of the nine, and values of the wrong shape", () => {
    const run = startRun()!;
    const before = JSON.stringify(getRun());
    reconcile({ __interrupt__: [interrupt("delete_everything", "x", "c0"), { id: "i", value: {} }, null], messages: [denial("delete_everything", "c0", "denied", "no"), "junk"] }, run.id);
    reconcile(undefined, run.id);
    reconcile("junk", run.id);
    expect(JSON.stringify(getRun())).toBe(before);
  });

  it("a foreign tool_ref that ends in one of the nine does not mark that step", () => {
    const run = startRun()!;
    reconcile({ __interrupt__: [{ id: "i", value: { approval_id: "x", tool_ref: "ext:other:adp_create_employee" } }] }, run.id);
    expect(step("adp_create_employee").status).toBe("pending");
  });

  it("reads a checkpoint's plain message too", () => {
    const run = startRun()!;
    reconcile({ messages: [{ type: "tool", name: "okta_assign_admin_role", status: "error", content: "no", additional_kwargs: { noblecloak: { code: "denied" } } }] }, run.id);
    expect(step("okta_assign_admin_role").status).toBe("denied");
  });
});
