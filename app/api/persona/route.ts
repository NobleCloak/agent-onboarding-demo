import { NextResponse } from "next/server";
import { z } from "zod";
import { PERSONA_COOKIE, PERSONAS, type PersonaKey } from "../../../lib/approvals";
import { currentMode } from "../../../lib/mode";
import { personaOf } from "../../../lib/persona-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = (persona: PersonaKey) => ({ persona, displayName: PERSONAS[persona].displayName, team: PERSONAS[persona].team });

// Deployment mode: the one signed-in person is the approver, so there is no persona to read or switch.
const mockOnly = () => NextResponse.json({ error: "Personas are a mock-mode feature. In deployment mode the signed-in person decides." }, { status: 404 });

export function GET(request: Request) {
  if (currentMode() === "deployment") return mockOnly();
  return NextResponse.json(view(personaOf(request)));
}

export async function POST(request: Request) {
  if (currentMode() === "deployment") return mockOnly();
  const parsed = z.object({ persona: z.enum(["priya", "sam"]) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "persona must be priya or sam" }, { status: 400 });
  const res = NextResponse.json(view(parsed.data.persona));
  // The cookie holds only the persona's key. The approver token stays on the server.
  res.cookies.set(PERSONA_COOKIE, parsed.data.persona, { httpOnly: true, sameSite: "strict", path: "/" });
  return res;
}
