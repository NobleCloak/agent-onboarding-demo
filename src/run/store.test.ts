import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStore, failUnfinishedSteps, getRun, resetRun, setRunState, setStep, startRun } from "./store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fernhill-store-"));
  process.env.FERNHILL_DATA_DIR = dir;
});
afterEach(() => {
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
});

describe("run store", () => {
  it("starts idle with nine pending steps", () => {
    const run = getRun();
    expect(run.state).toBe("idle");
    expect(run.steps).toHaveLength(9);
    expect(run.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("startRun returns null while a run is active", () => {
    const first = startRun();
    expect(first?.state).toBe("running");
    expect(startRun()).toBeNull();
    setRunState(first!.id, "parked");
    expect(startRun()).toBeNull();
    setRunState(first!.id, "finished");
    expect(startRun()).not.toBeNull();
  });

  it("setStep patches one step and survives a reopen", () => {
    const first = startRun()!;
    setStep(first.id, "mercury_issue_card", { status: "done", detail: "Limit $25,000 / month" });
    closeStore();
    const step = getRun().steps.find((s) => s.tool === "mercury_issue_card");
    expect(step).toMatchObject({ status: "done", detail: "Limit $25,000 / month" });
  });

  it("resetRun returns to idle with pending steps", async () => {
    const started = startRun()!;
    setStep(started.id, "slack_invite", { status: "done" });
    await resetRun();
    const run = getRun();
    expect(run.state).toBe("idle");
    expect(run.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("writes for a run that is no longer current are no-ops", async () => {
    const old = startRun()!;
    await resetRun();
    setStep(old.id, "slack_invite", { status: "done" });
    setRunState(old.id, "finished");
    failUnfinishedSteps(old.id, "late");
    expect(getRun().state).toBe("idle");
    expect(getRun().steps.every((s) => s.status === "pending")).toBe(true);

    const next = startRun()!;
    setStep(old.id, "slack_invite", { status: "done" });
    setRunState(old.id, "finished");
    const now = getRun();
    expect(now.id).toBe(next.id);
    expect(now.state).toBe("running");
    expect(now.steps.every((s) => s.status === "pending")).toBe(true);
  });
});
