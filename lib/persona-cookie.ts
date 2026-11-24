import { parsePersona, PERSONA_COOKIE, type PersonaKey } from "./approvals";

/** The chosen persona from a request's Cookie header. Absent or unknown means the default. */
export function personaOf(request: Request): PersonaKey {
  const header = request.headers.get("cookie") ?? "";
  const match = header.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${PERSONA_COOKIE}=`));
  return parsePersona(match?.slice(PERSONA_COOKIE.length + 1));
}
