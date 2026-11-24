import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { emptyCheckpoint, uuid6 } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointFile, closeStore, getRun, openDb, readThread, setRunState, setStep, startRun } from "./store";
import { syncParkedRun } from "./sync";

const REJECTED = {
  id: "ap-card",
  state: "rejected",
  tool_ref: "ext:fernhill-desk:mercury_issue_card",
  action_digest: "d",
  created_at: new Date().toISOString(),
  resolution_history: [{ resolution: "rejected", by: { id: "user_sam_okoye", display_name: "Sam Okoye" }, at: new Date().toISOString(), reason: "Not this month" }],
};
const PENDING = { ...REJECTED, id: "ap-pay", state: "pending", tool_ref: "ext:fernhill-desk:adp_create_employee", resolution_history: [] };
const APPROVED = { ...PENDING, state: "approved", resolution_history: [{ resolution: "approved", by: { id: "user_priya_shah", display_name: "Priya Shah" }, at: new Date().toISOString() }] };

/** Answers the approvals client the way the local mock does, from a table of approvals. */
const depsFor = (approvals: Record<string, unknown>, failing = false) => ({
  baseUrl: "http://mock.test",
  fetch: (async (input: RequestInfo | URL) => {
    const req = new Request(input);
    if (failing) throw new TypeError("fetch failed");
    if (req.url.includes("/__demo/token")) return Response.json({ token: "t" });
    const id = req.url.split("/").pop()!;
    return id in approvals ? Response.json({ data: approvals[id] }) : Response.json({}, { status: 404 });
  }) as typeof fetch,
});

const CONFIG = (id: string) => ({ configurable: { thread_id: id, checkpoint_ns: "" } });

async function store(runId: string, messages: unknown[], writes: [string, unknown][] = []) {
  const db = openDb(checkpointFile());
  const saver = new SqliteSaver(db);
  const checkpoint = { ...emptyCheckpoint(), id: uuid6(0), channel_values: { messages } };
  const cfg = await saver.put(CONFIG(runId), checkpoint, { source: "loop", step: 1, parents: {} });
  if (writes.length) await saver.putWrites(cfg, writes, "task-1");
  db.close();
}

const denied = new ToolMessage({ name: "mercury_issue_card", tool_call_id: "c8", status: "error", content: "Governance denied this call (rejected_duplicate). The tool was not run.", additional_kwargs: { noblecloak: { code: "denied" } } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fernhill-sync-"));
  process.env.FERNHILL_DATA_DIR = dir;
});
afterEach(() => {
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("readThread", () => {
  it("has nothing for a thread that was never stored", async () => {
    const run = startRun()!;
    expect(await readThread(run.id)).toBeNull();
  });
  it("reads finished calls and interrupts from pending writes, and is not finished while they exist", async () => {
    const run = startRun()!;
    const value = { approval_id: "ap-pay", tool_ref: "ext:fernhill-desk:adp_create_employee" };
    await store(run.id, [new HumanMessage("x")], [["__interrupt__", { id: "i", value }], ["messages", denied]]);
    const t = await readThread(run.id);
    expect(t?.finished).toBe(false);
    expect(t?.__interrupt__).toEqual([{ id: "i", value }]);
    expect((t?.messages as { name?: string }[]).map((m) => m.name)).toContain("mercury_issue_card");
  });
  it("is finished when the model's last message asks for nothing and nothing is pending", async () => {
    const run = startRun()!;
    await store(run.id, [new AIMessage("Maya Torres is set up.")]);
    expect((await readThread(run.id))?.finished).toBe(true);
  });
  it("is not finished while a write is pending, even after a closing message", async () => {
    const run = startRun()!;
    await store(run.id, [new AIMessage("Maya Torres is set up.")], [["branch:to:model_request", null]]);
    expect((await readThread(run.id))?.finished).toBe(false);
  });
  it("is not finished while the model's last message asks for a tool", async () => {
    const run = startRun()!;
    await store(run.id, [new AIMessage({ content: "", tool_calls: [{ id: "c", name: "slack_invite", args: {}, type: "tool_call" }] })]);
    expect((await readThread(run.id))?.finished).toBe(false);
  });
});

describe("syncParkedRun", () => {
  it("does nothing unless the run is parked", async () => {
    const run = startRun()!;
    await store(run.id, [new AIMessage("Done")]);
    await syncParkedRun(depsFor({}));
    expect(getRun().state).toBe("running");
  });

  it("marks the card denied with the approver's name and reason from resolution_history, not the tool message", async () => {
    const run = startRun()!;
    setRunState(run.id, "parked");
    setStep(run.id, "mercury_issue_card", { status: "waiting", approvalId: "ap-card" });
    await store(run.id, [denied, new AIMessage("Maya Torres is set up.")]);
    await syncParkedRun(depsFor({ "ap-card": REJECTED }));
    const card = getRun().steps.find((s) => s.tool === "mercury_issue_card")!;
    expect(card).toMatchObject({ status: "denied", decidedBy: "Sam Okoye", resolution: "rejected", reason: "Not this month" });
    expect(getRun().state).toBe("finished");
  });

  it("a decision the worker has not acted on shows on the waiting step and the run stays parked", async () => {
    const run = startRun()!;
    setRunState(run.id, "parked");
    setStep(run.id, "adp_create_employee", { status: "waiting", approvalId: "ap-pay" });
    await store(run.id, [new HumanMessage("x")], [["__interrupt__", { id: "i", value: { approval_id: "ap-pay", tool_ref: "ext:fernhill-desk:adp_create_employee" } }]]);
    await syncParkedRun(depsFor({ "ap-pay": APPROVED }));
    expect(getRun().steps.find((s) => s.tool === "adp_create_employee")).toMatchObject({ status: "waiting", decidedBy: "Priya Shah", resolution: "approved" });
    expect(getRun().state).toBe("parked");
  });

  it("an undecided approval leaves the step waiting with no decision", async () => {
    const run = startRun()!;
    setRunState(run.id, "parked");
    setStep(run.id, "adp_create_employee", { status: "waiting", approvalId: "ap-pay" });
    await store(run.id, [new HumanMessage("x")], [["__interrupt__", { id: "i", value: { approval_id: "ap-pay", tool_ref: "ext:fernhill-desk:adp_create_employee" } }]]);
    await syncParkedRun(depsFor({ "ap-pay": PENDING }));
    const s = getRun().steps.find((x) => x.tool === "adp_create_employee")!;
    expect(s.status).toBe("waiting");
    expect(s.decidedBy).toBeUndefined();
  });

  it("deployment mode with no bearer skips the decision read quietly: no request, no DECISION_READ_FAILED", async () => {
    const run = startRun()!;
    setRunState(run.id, "parked");
    setStep(run.id, "mercury_issue_card", { status: "waiting", approvalId: "ap-card" });
    await store(run.id, [denied]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const deps = { ...depsFor({ "ap-card": REJECTED }), baseUrl: "https://nc.test", mode: "deployment" as const };
    const inner = deps.fetch;
    await syncParkedRun({ ...deps, fetch: (async (...a: Parameters<typeof fetch>) => (calls.push(String(a[0])), inner(...a))) as typeof fetch });
    expect(calls).toEqual([]);
    expect(err).not.toHaveBeenCalled();
    expect(getRun().steps.find((s) => s.tool === "mercury_issue_card")?.decidedBy).toBeUndefined();
  });

  it("deployment mode with the caller's bearer still writes no decision detail into the shared store", async () => {
    const run = startRun()!;
    setRunState(run.id, "parked");
    setStep(run.id, "mercury_issue_card", { status: "waiting", approvalId: "ap-card" });
    await store(run.id, [denied]);
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", "https://nc.test");
    await syncParkedRun({ ...depsFor({ "ap-card": REJECTED }), baseUrl: "https://nc.test", mode: "deployment", bearer: "tok" });
    const card = getRun().steps.find((s) => s.tool === "mercury_issue_card")!;
    expect(card.decidedBy).toBeUndefined();
    expect(card.resolution).toBeUndefined();
  });

  it("the mock being unreachable keeps the tool message's reason, logs it, and does not throw", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = startRun()!;
    setRunState(run.id, "parked");
    setStep(run.id, "mercury_issue_card", { status: "waiting", approvalId: "ap-card" });
    await store(run.id, [denied, new AIMessage("end")]);
    await syncParkedRun(depsFor({}, true));
    expect(getRun().steps.find((s) => s.tool === "mercury_issue_card")).toMatchObject({ status: "denied", reason: denied.content });
    expect(log).toHaveBeenCalled();
  });
});
