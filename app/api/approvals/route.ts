import { NextResponse } from "next/server";
import { ApprovalsError, DEFAULT_PERSONA, fetchRunApprovals, PERSONAS } from "../../../lib/approvals";
import { currentMode } from "../../../lib/mode";
import { callerDeps, statusOf } from "../../../lib/route-auth";
import { personaOf } from "../../../lib/persona-cookie";
import { getRun } from "../../../src/run/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The panel polls this every few hundred ms, so a standing failure is logged when it appears or changes, not per poll.
let lastFailure: string | null = null;

export async function GET(request: Request) {
  // Deployment mode: one signed-in person decides, so a persona cookie is ignored.
  const persona = currentMode() === "deployment" ? DEFAULT_PERSONA : personaOf(request);
  const caller = callerDeps(request);
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  try {
    const { reachable, approvals } = await fetchRunApprovals(getRun(), persona, caller.deps);
    lastFailure = null;
    // Deployment mode has no persona: the one signed-in person decides, and naming a mock approver would be wrong.
    if (currentMode() === "deployment") return NextResponse.json({ reachable, approvals });
    return NextResponse.json({ persona, displayName: PERSONAS[persona].displayName, reachable, approvals });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastFailure) console.error(`[fernhill] APPROVALS_LIST_FAILED ${message}`);
    lastFailure = message;
    return NextResponse.json({ error: message }, { status: statusOf(error, error instanceof ApprovalsError ? 502 : 500) });
  }
}
