import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import { z } from "zod";
import { TOOL_NAMES, type Run, type RunState, type Step, type ToolName } from "./types";

// One SQLite file shared by the Next app and the worker process. The run is a single JSON row, so every
// read-modify-write happens inside one IMMEDIATE transaction and two processes cannot interleave.

const StepSchema = z.object({
  tool: z.enum(TOOL_NAMES),
  status: z.enum(["pending", "done", "waiting", "denied", "failed", "skipped"]),
  args: z.unknown().optional(),
  detail: z.string().optional(),
  approvalId: z.string().optional(),
  reason: z.string().optional(),
  decidedBy: z.string().optional(),
  resolution: z.enum(["approved", "rejected"]).optional(),
});
const RunSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  state: z.enum(["idle", "running", "parked", "finished"]),
  steps: z.array(StepSchema),
});

/** Resolved on every call so tests (and a worker started elsewhere) can point at another directory. */
export const dataDir = () => resolve(process.env.FERNHILL_DATA_DIR ?? ".data");
export const checkpointFile = () => join(dataDir(), "checkpoints.sqlite");

/** Open a WAL-mode connection. Shared by the run store and the checkpointer. */
export function openDb(file: string): Database.Database {
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  return db;
}

const idleRun = (): Run => ({
  id: "",
  startedAt: "",
  state: "idle",
  steps: TOOL_NAMES.map((tool) => ({ tool, status: "pending" as const })),
});

let cached: { file: string; db: Database.Database } | null = null;

function db(): Database.Database {
  const file = join(dataDir(), "run.sqlite");
  if (cached?.file === file) return cached.db;
  closeStore();
  const handle = openDb(file);
  handle.exec("CREATE TABLE IF NOT EXISTS run (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
  handle.prepare("INSERT OR IGNORE INTO run (id, data) VALUES (1, ?)").run(JSON.stringify(idleRun()));
  cached = { file, db: handle };
  return handle;
}

export function closeStore(): void {
  cached?.db.close();
  cached = null;
}

function read(handle: Database.Database): Run {
  const row = handle.prepare("SELECT data FROM run WHERE id = 1").get() as { data: string };
  return RunSchema.parse(JSON.parse(row.data));
}
const write = (handle: Database.Database, run: Run) =>
  void handle.prepare("UPDATE run SET data = ? WHERE id = 1").run(JSON.stringify(run));

/** Read-modify-write under one write lock. Return the new run, or null to leave it unchanged. */
function mutate<T>(fn: (run: Run) => { run: Run; result: T } | { run: null; result: T }): T {
  const handle = db();
  return handle.transaction(() => {
    const out = fn(read(handle));
    if (out.run) write(handle, out.run);
    return out.result;
  }).immediate();
}

export const getRun = (): Run => read(db());

/** Begin a new run. Returns null if one is already running or parked, so concurrent POSTs yield one run. */
export function startRun(): Run | null {
  return mutate((current) => {
    if (current.state === "running" || current.state === "parked") return { run: null, result: null };
    const next: Run = { ...idleRun(), id: randomUUID(), startedAt: new Date().toISOString(), state: "running" };
    return { run: next, result: next };
  });
}

// Every write names the run it belongs to. A write for a run that is no longer current (after a reset, or from
// a stale worker) is a silent no-op, so an old agent can never touch an idle or newer run.

export const isCurrent = (runId: string): boolean => getRun().id === runId;

export function setStep(runId: string, tool: ToolName, patch: Partial<Omit<Step, "tool">>): void {
  mutate((run) => {
    if (run.id !== runId) return { run: null, result: undefined };
    const step = run.steps.find((s) => s.tool === tool);
    if (!step) throw new Error(`unknown step ${tool}`);
    Object.assign(step, patch);
    return { run, result: undefined };
  });
}

export function setRunState(runId: string, state: RunState): void {
  mutate((run) => (run.id !== runId ? { run: null, result: undefined } : { run: { ...run, state }, result: undefined }));
}

/** Change several steps in one write lock, so a tool finishing in another process cannot be overwritten. */
export function updateSteps(runId: string, change: (steps: Step[]) => void): void {
  mutate((run) => {
    if (run.id !== runId) return { run: null, result: undefined };
    change(run.steps);
    return { run, result: undefined };
  });
}

/** Mark every step that never finished as failed, with the reason shown on screen. */
export function failUnfinishedSteps(runId: string, reason: string): void {
  mutate((run) => {
    if (run.id !== runId) return { run: null, result: undefined };
    for (const step of run.steps) {
      if (step.status === "pending" || step.status === "waiting") Object.assign(step, { status: "failed", reason });
    }
    return { run, result: undefined };
  });
}

/** Delete one run's checkpoints. */
export async function deleteCheckpoints(runId: string): Promise<void> {
  if (!runId) return;
  const handle = openDb(checkpointFile());
  try {
    // The saver creates its tables lazily, so a run that never checkpointed has nothing to delete.
    const hasTables = handle.prepare("SELECT 1 FROM sqlite_master WHERE name = 'checkpoints'").get();
    if (hasTables) await new SqliteSaver(handle).deleteThread(runId);
  } finally {
    handle.close();
  }
}

export type ThreadSnapshot = { messages: unknown[]; __interrupt__: unknown[]; finished: boolean };

/**
 * What a thread looks like right now, from the shared checkpoint file, in the shape `invoke` returns. Works for a run
 * the worker is resuming in another process. In a turn with parallel calls, finished calls and open interrupts are
 * only pending writes until the whole turn is done, so they are read from there too. Null when nothing is stored.
 */
export async function readThread(runId: string): Promise<ThreadSnapshot | null> {
  const handle = openDb(checkpointFile());
  try {
    if (!handle.prepare("SELECT 1 FROM sqlite_master WHERE name = 'checkpoints'").get()) return null;
    const tuple = await new SqliteSaver(handle).getTuple({ configurable: { thread_id: runId } });
    if (!tuple) return null;
    const values = tuple.checkpoint.channel_values as { messages?: unknown };
    const stored = Array.isArray(values.messages) ? (values.messages as unknown[]) : [];
    const writes = tuple.pendingWrites ?? [];
    const written = writes.filter(([, channel]) => channel === "messages").flatMap(([, , value]) => (Array.isArray(value) ? (value as unknown[]) : [value]));
    const interrupts = writes.filter(([, channel]) => channel === "__interrupt__").flatMap(([, , value]) => (Array.isArray(value) ? (value as unknown[]) : [value]));
    const last = stored.at(-1) as { getType?: () => string; tool_calls?: unknown[] } | undefined;
    // The agent has ended when nothing is pending and the model's last message asks for no tool.
    const finished = writes.length === 0 && last?.getType?.() === "ai" && !last.tool_calls?.length;
    return { messages: [...stored, ...written], __interrupt__: interrupts, finished };
  } finally {
    handle.close();
  }
}

/** Clear the run store and delete the run's checkpoints. */
export async function resetRun(): Promise<void> {
  const { id } = getRun();
  mutate(() => ({ run: idleRun(), result: undefined }));
  await deleteCheckpoints(id);
}
