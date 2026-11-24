import { NextResponse } from "next/server";
import { currentMode } from "../../../lib/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Is this app up? Answers without a sign-in and without contacting NobleCloak, so a launcher can wait on it in
// deployment mode, where /api/run is 401 until someone signs in. It carries no run, no approval and no token.
export function GET() {
  return NextResponse.json({ ok: true, mode: currentMode() });
}
