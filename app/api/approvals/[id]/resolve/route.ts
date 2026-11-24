import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_PERSONA, resolveApproval } from "../../../../../lib/approvals";
import { currentMode } from "../../../../../lib/mode";
import { personaOf } from "../../../../../lib/persona-cookie";
import { callerDeps, statusOf } from "../../../../../lib/route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ decision: z.enum(["approve", "deny"]), expectedActionDigest: z.string().min(1), reason: z.string().max(500).optional() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, status: 400, message: "decision and expectedActionDigest are required." }, { status: 400 });
  const caller = callerDeps(request);
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  const { id } = await params;
  try {
    // Deployment mode: the signed-in person decides, so a persona cookie is ignored.
    const persona = currentMode() === "deployment" ? DEFAULT_PERSONA : personaOf(request);
    const result = await resolveApproval(id, parsed.data.decision, parsed.data.expectedActionDigest, persona, parsed.data.reason, caller.deps);
    // Only the outcome goes back: no token, no raw approval.
    return NextResponse.json(result.ok ? { ok: true } : result, { status: result.ok ? 200 : result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fernhill] APPROVAL_RESOLVE_FAILED ${id} ${message}`);
    const status = statusOf(error, 502);
    return NextResponse.json({ ok: false, status, message: status === 502 ? "Could not reach NobleCloak to record the decision." : message }, { status });
  }
}
