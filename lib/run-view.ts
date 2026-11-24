import { TOOL_NAMES, type Run } from "../src/run/types";
import { getApproval, type Deps } from "./approvals";
import type { Mode } from "./mode";

/**
 * The run for the server-rendered page. Deployment mode: without who decided and why, which were read with a signed-in
 * person's token; the browser fetches those from /api/run with its own token.
 */
export function forPage(run: Run, mode: Mode): Run {
  if (mode !== "deployment") return run;
  return { ...run, steps: run.steps.map(({ reason: _r, decidedBy: _d, resolution: _x, ...rest }) => rest) };
}

/**
 * The run the onboarding page is first rendered with. Deployment mode: an idle skeleton with nothing from the stored run
 * (no id, arguments, detail or approval id), because the page is rendered for whoever asks, signed in or not; the
 * browser loads the real run from /api/run with its own token.
 */
export function firstPaint(run: Run, mode: Mode): Run {
  if (mode !== "deployment") return run;
  return { id: "", startedAt: "", state: "idle", steps: TOOL_NAMES.map((tool) => ({ tool, status: "pending" as const })) };
}

/**
 * The run for /api/run in deployment mode: no decision detail from the shared store, then who decided and why for each
 * approval THIS caller's token can read, read now. An approval the caller cannot read (403, 404, unreachable) adds nothing.
 */
export async function withCallerDecisions(run: Run, deps: Deps, read: typeof getApproval = getApproval): Promise<Run> {
  const base = forPage(run, "deployment");
  const steps = await Promise.all(
    base.steps.map(async (step) => {
      if (!step.approvalId) return step;
      let decision;
      try {
        decision = (await read(step.approvalId, "priya", deps))?.decision;
      } catch (error) {
        console.error(`[fernhill] DECISION_READ_FAILED ${step.approvalId}`, error);
        return step;
      }
      if (!decision) return step;
      const rejected = decision.resolution === "rejected";
      return {
        ...step,
        decidedBy: decision.by,
        resolution: decision.resolution,
        ...(step.status === "denied" || rejected ? { reason: decision.reason ?? "No reason given" } : {}),
      };
    }),
  );
  return { ...base, steps };
}
