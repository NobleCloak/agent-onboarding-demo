import { HumanMessage } from "@langchain/core/messages";
import { reconcile } from "../run/reconcile";
import { deleteCheckpoints, failUnfinishedSteps, isCurrent, setRunState } from "../run/store";
import { buildAgent, PROMPT } from "./agent";

/** Run the agent for one run id (the checkpoint thread). Never throws: a failure is logged and shown on the run. */
export async function startAgentRun(runId: string): Promise<void> {
  try {
    const result = (await buildAgent().invoke(
      { messages: [new HumanMessage(PROMPT)] },
      { configurable: { thread_id: runId } },
    )) as { __interrupt__?: unknown[] };
    reconcile(result, runId);
    // An interrupted invoke returns normally with a pending interrupt: that run is parked, not finished.
    setRunState(runId, result.__interrupt__?.length ? "parked" : "finished");
  } catch (error) {
    console.error(`[fernhill] agent run ${runId} failed`, error);
    const reason = error instanceof Error ? error.message : String(error);
    failUnfinishedSteps(runId, `Agent error: ${reason}`);
    setRunState(runId, "finished");
  }
  // If the run was reset while we were going, the checkpointer may have recreated its thread. Remove it.
  if (!isCurrent(runId)) await deleteCheckpoints(runId).catch((e) => console.error("[fernhill] checkpoint cleanup failed", e));
}
