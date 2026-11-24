import { getApproval, type Deps } from "../../lib/approvals";
import { currentMode } from "../../lib/mode";
import { getRun, readThread, setRunState, updateSteps } from "./store";
import { reconcile } from "./reconcile";

/**
 * A parked run is carried on by the resumer worker, a separate process that knows nothing about this app's run store.
 * So the app reads the thread from the shared checkpoint file and brings the run up to date: step states, who decided
 * and why (from the approval, never from a tool message's wording), and whether the run has ended.
 */
export async function syncParkedRun(deps: Deps = {}): Promise<void> {
  const run = getRun();
  if (run.state !== "parked") return;
  const thread = await readThread(run.id);
  if (!thread) return;
  reconcile(thread, run.id);
  await recordDecisions(run.id, deps);
  if (thread.finished) setRunState(run.id, "finished");
}

/** Copy the decision onto every step that waited on a person and does not show one yet. */
async function recordDecisions(runId: string, deps: Deps): Promise<void> {
  // Deployment mode keeps no decision detail in this shared store: who decided and why is read per request with the
  // caller's own token (lib/run-view withCallerDecisions), so one person's token never lends it to another's.
  if ((deps.mode ?? currentMode()) === "deployment") return;
  const open = getRun().steps.filter((s) => s.approvalId && !s.decidedBy && (s.status === "waiting" || s.status === "denied"));
  for (const step of open) {
    let decision;
    try {
      decision = (await getApproval(step.approvalId!, "priya", deps))?.decision;
    } catch (error) {
      // The step keeps what it has (the tool message's reason), and the next poll tries again while the run is parked.
      console.error(`[fernhill] DECISION_READ_FAILED ${step.approvalId}`, error);
      continue;
    }
    if (!decision) continue;
    const { by, resolution, reason } = decision;
    updateSteps(runId, (steps) => {
      const s = steps.find((x) => x.tool === step.tool);
      if (!s) return;
      Object.assign(s, { decidedBy: by, resolution });
      if (s.status === "denied" || resolution === "rejected") s.reason = reason ?? "No reason given";
    });
  }
}
