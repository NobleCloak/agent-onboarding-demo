import { NextResponse } from "next/server";
import { startAgentRun } from "../../../src/agent/start";
import { ApprovalsError, verifyBearer, type Deps } from "../../../lib/approvals";
import { currentMode, DeploymentConfigError, refusal } from "../../../lib/mode";
import { callerDeps } from "../../../lib/route-auth";
import { getRun, resetRun, startRun } from "../../../src/run/store";
import { withCallerDecisions } from "../../../lib/run-view";
import { syncParkedRun } from "../../../src/run/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment mode: every method needs a signed-in caller, and a bearer header is only a claim, so the deployment is
 * asked to accept it first. Returns the refusal to send, or the deps to carry on with. Mock mode asks nothing.
 */
async function admit(request: Request): Promise<{ refusal: Response } | { deps: Deps }> {
  const caller = callerDeps(request);
  if (!caller.ok) return { refusal: NextResponse.json(caller.body, { status: caller.status }) };
  if (currentMode() === "deployment") {
    try {
      await verifyBearer(caller.deps);
    } catch (error) {
      const status = error instanceof ApprovalsError ? error.status : error instanceof DeploymentConfigError ? 500 : 502;
      return { refusal: NextResponse.json(refusal(status, error instanceof Error ? error.message : "Could not check this sign-in."), { status }) };
    }
  }
  return { deps: caller.deps };
}

export async function GET(request: Request) {
  const admitted = await admit(request);
  if ("refusal" in admitted) return admitted.refusal;
  const caller = { deps: admitted.deps };
  // A failed sync must not take the page down: it shows the last known state and the next poll tries again.
  await syncParkedRun(caller.deps).catch((error) => console.error("[fernhill] RUN_SYNC_FAILED", error));
  // Deployment mode: decision detail only for what this caller's own token can read, never from the shared store.
  if (currentMode() === "deployment") return NextResponse.json(await withCallerDecisions(getRun(), caller.deps));
  return NextResponse.json(getRun());
}

export async function POST(request: Request) {
  const admitted = await admit(request);
  if ("refusal" in admitted) return admitted.refusal;
  const run = startRun();
  if (!run) return NextResponse.json({ error: "A run is already active" }, { status: 409 });
  void startAgentRun(run.id); // background; startAgentRun reports its own failures on the run
  return NextResponse.json(run, { status: 202 });
}

export async function DELETE(request: Request) {
  const admitted = await admit(request);
  if ("refusal" in admitted) return admitted.refusal;
  await resetRun();
  return NextResponse.json(getRun());
}
