import { forwardToNc } from "../../../../lib/nc-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Permissions module's same-origin path to the local NobleCloak. The allowlist and the token live in lib/nc-proxy.ts;
// proxy.ts's cross-site check covers every write sent here, because it matches all of /api/*.
type Ctx = { params: Promise<{ path: string[] }> };
const handle = async (request: Request, { params }: Ctx) => forwardToNc(request, (await params).path);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
