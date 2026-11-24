import { NextResponse } from "next/server";
import { z } from "zod";
import { callerDeps, statusOf } from "../../../../../lib/route-auth";
import { approveProposal } from "../../../../../lib/proposal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ expectedActionDigest: z.string().min(1) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, status: 400, message: "expectedActionDigest is required." }, { status: 400 });
  const caller = callerDeps(request);
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  const { id } = await params;
  try {
    const out = await approveProposal(id, parsed.data.expectedActionDigest, caller.deps);
    return NextResponse.json(out, { status: out.ok ? 200 : out.status });
  } catch (error) {
    console.error(`[fernhill] PROPOSAL_APPROVE_FAILED ${id}`, error);
    const status = statusOf(error, 502);
    return NextResponse.json({ ok: false, status, message: status === 502 ? "Could not reach NobleCloak to approve the rules." : error instanceof Error ? error.message : String(error) }, { status });
  }
}
