import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, getRun, resetRun, setStep, startRun } from "../run/store";

let behavior: (runId: string) => Promise<unknown> = async () => ({});
vi.mock("./agent", () => ({
  PROMPT: "test",
  buildAgent: () => ({
    invoke: (_input: unknown, config: { configurable: { thread_id: string } }) => behavior(config.configurable.thread_id),
  }),
}));
vi.mock("../noblecloak/governance", () => ({ agentGovernance: async () => ({}) }));
vi.mock("../noblecloak/governed-agent", async () => {
  const { buildAgent } = await import("./agent");
  return { buildGovernedAgent: () => buildAgent() };
});
import { startAgentRun } from "./start";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fernhill-start-"));
  process.env.FERNHILL_DATA_DIR = dir;
});
afterEach(() => {
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
});

describe("startAgentRun failure", () => {
  it("marks unfinished steps failed, finishes the run, and logs the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    behavior = async (id) => {
      setStep(id, "okta_create_user", { status: "done" });
      throw new Error("model exploded");
    };
    const run = startRun()!;
    await startAgentRun(run.id);
    const after = getRun();
    expect(after.state).toBe("finished");
    expect(after.steps.find((s) => s.tool === "okta_create_user")?.status).toBe("done");
    const failed = after.steps.filter((s) => s.status === "failed");
    expect(failed).toHaveLength(8);
    expect(failed[0].reason).toContain("model exploded");
    expect(log).toHaveBeenCalled();
  });
});

describe("startAgentRun with a governance error", () => {
  it("a governance error marks the steps failed with the reason, and none shows done", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The adapter rethrows a GovernanceError whatever handleToolErrors says, so it arrives here as a failed invoke.
    behavior = async () => {
      throw Object.assign(new Error("/v1 could not be reached: fetch failed"), { name: "GovernanceError", code: "unreachable" });
    };
    const run = startRun()!;
    await startAgentRun(run.id);
    const after = getRun();
    expect(after.state).toBe("finished");
    expect(after.steps.every((s) => s.status === "failed")).toBe(true);
    expect(after.steps[0].reason).toContain("/v1 could not be reached");
  });
});

describe("startAgentRun outcomes", () => {
  it("records what the agent returned on the steps: waiting with its approval, denied with its reason", async () => {
    behavior = async () => ({
      messages: [{ type: "tool", name: "okta_assign_admin_role", status: "error", content: "Governance denied this call (deny). The tool was not run.", additional_kwargs: { noblecloak: { code: "denied" } } }],
      __interrupt__: [{ id: "i1", value: { approval_id: "ap-pay", tool_ref: "ext:fernhill-desk:adp_create_employee" } }],
    });
    const run = startRun()!;
    await startAgentRun(run.id);
    const after = getRun();
    expect(after.state).toBe("parked");
    expect(after.steps.find((s) => s.tool === "adp_create_employee")).toMatchObject({ status: "waiting", approvalId: "ap-pay" });
    expect(after.steps.find((s) => s.tool === "okta_assign_admin_role")).toMatchObject({ status: "denied" });
  });

  it("parks the run when invoke returns a pending interrupt", async () => {
    behavior = async () => ({ __interrupt__: [{ id: "i1", value: {} }] });
    const run = startRun()!;
    await startAgentRun(run.id);
    expect(getRun().state).toBe("parked");
  });

  it("finishes the run when invoke returns no interrupt", async () => {
    behavior = async () => ({ messages: [] });
    const run = startRun()!;
    await startAgentRun(run.id);
    expect(getRun().state).toBe("finished");
  });

  it("a reset mid-run leaves the row idle and a newer run untouched", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    behavior = async (id) => {
      await gate;
      setStep(id, "slack_invite", { status: "done" });
      return {};
    };
    const old = startRun()!;
    const pending = startAgentRun(old.id);
    await resetRun();
    const next = startRun()!;
    release();
    await pending;
    const now = getRun();
    expect(now.id).toBe(next.id);
    expect(now.state).toBe("running");
    expect(now.steps.every((s) => s.status === "pending")).toBe(true);
  });
});
