import { NextResponse } from "next/server";
import { callerDeps, statusOf } from "../../../lib/route-auth";
import { readProposal } from "../../../lib/proposal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The page polls this, so a standing failure is logged when it appears or changes, not on every poll.
let lastFailure: string | null = null;

export async function GET(request: Request) {
  const caller = callerDeps(request);
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  try {
    const out = await readProposal(caller.deps);
    lastFailure = null;
    return NextResponse.json(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastFailure) console.error(`[fernhill] PROPOSAL_READ_FAILED ${message}`);
    lastFailure = message;
    return NextResponse.json({ error: message }, { status: statusOf(error, 502) });
  }
}
