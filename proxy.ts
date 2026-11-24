import { NextResponse, type NextRequest } from "next/server";

// Guards the state-changing API routes against a web page the presenter happens to have open (CSRF).
// The app binds to 127.0.0.1 only, but any page in the same browser can still POST to it.

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_ORIGINS = ["http://127.0.0.1:3417", "http://localhost:3417"];

const normalize = (o: string) => o.trim().replace(/\/+$/, "");

function allowedOrigins(): string[] {
  const raw = process.env.FERNHILL_ALLOWED_ORIGINS;
  const list = raw ? raw.split(",").map(normalize).filter(Boolean) : [];
  return list.length ? list : DEFAULT_ORIGINS;
}

export function isAllowedWrite(
  req: { method: string; origin: string | null; secFetchSite: string | null },
  allowed: string[],
): boolean {
  if (!WRITE_METHODS.has(req.method.toUpperCase())) return true;
  if (req.secFetchSite === "cross-site") return false;
  // No Origin: curl and scripts, which are allowed (a browser cross-site request is caught above).
  if (req.origin === null) return true;
  return allowed.includes(normalize(req.origin));
}

/**
 * DNS rebinding: a page on another site can resolve its own name to 127.0.0.1 and then talk to this app as "same origin".
 * The browser still sends that attacker's name as Host, so any Host that is not this app's own is refused, for every method.
 * The app's own hosts are 127.0.0.1 and localhost on the port of each allowed origin, plus each allowed origin's host.
 */
export function isAllowedHost(host: string | null, allowed: string[]): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const origin of allowed) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (h === url.host.toLowerCase()) return true;
    if (url.port !== "" && (h === `127.0.0.1:${url.port}` || h === `localhost:${url.port}`)) return true;
  }
  return false;
}

export function proxy(req: NextRequest) {
  // The matcher already limits this to /api, but keep the check so the function is safe on its own.
  if (!req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();
  if (!isAllowedHost(req.headers.get("host") ?? req.nextUrl.host, allowedOrigins())) {
    return NextResponse.json({ error: "Unrecognized host" }, { status: 403 });
  }
  const ok = isAllowedWrite(
    { method: req.method, origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site") },
    allowedOrigins(),
  );
  if (!ok) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
