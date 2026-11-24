import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStore, getRun, resetRun, startRun } from "../run/store";
import { TOOLS } from "./agent";
import { startAgentRun } from "./start";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fernhill-agent-"));
  process.env.FERNHILL_DATA_DIR = dir;
  process.env.FERNHILL_STEP_MS = "0";
});
afterEach(() => {
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
  delete process.env.FERNHILL_STEP_MS;
});

const checkpointRows = () => {
  const db = new Database(join(dir, "checkpoints.sqlite"));
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("scripted agent", () => {
  it("has nine tools", () => {
    expect(TOOLS).toHaveLength(9);
  });

  it("an ungoverned run marks all nine steps done", async () => {
    const run = startRun()!;
    await startAgentRun(run.id);
    const done = getRun();
    expect(done.state).toBe("finished");
    expect(done.steps).toHaveLength(9);
    expect(done.steps.every((s) => s.status === "done")).toBe(true);
    const by = (t: string) => done.steps.find((s) => s.tool === t)!;
    expect(by("mercury_issue_card").detail).toContain("$25,000 / month");
    expect(by("okta_assign_admin_role").detail).toContain("Org admin");
    expect(by("adp_create_employee").detail).toContain("copied from Dana");
    expect(by("mercury_issue_card").args).toMatchObject({ cardholder: "Maya Torres", limit_monthly: 25000 });
  });

  it("resetRun clears steps and the checkpoint", async () => {
    const run = startRun()!;
    await startAgentRun(run.id);
    expect(checkpointRows()).toBeGreaterThan(0);
    await resetRun();
    expect(getRun().steps.every((s) => s.status === "pending")).toBe(true);
    expect(checkpointRows()).toBe(0);
  });
});
