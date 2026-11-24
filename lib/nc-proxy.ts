import { hasFernhillTools, OURS } from "./fernhill-tools";
import { assertMock, bearerOf, DeploymentConfigError, SIGN_IN_REQUIRED, upstreamBase, currentMode, type Mode } from "./mode";

// Same-origin pass-through from the Permissions module in the browser to NobleCloak.
// Mock mode: the administrator's token stays on the server: the browser sends a placeholder, which is dropped here, and
// the real token is fetched from the mock's server-only /__mock/tokens and attached on the way out.
// Deployment mode: the browser sends the signed-in person's own bearer token and that one header is forwarded. This
// server never stores, mints or fetches a token, and never contacts the mock.
// Only the paths and methods the module uses are forwarded. Anything else (the mock's own /__mock and /__demo
// routes, approval resolution, tool registration) is refused before any request leaves this app.

const ID = "[A-Za-z0-9_.:-]+";
const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^v1\/capabilities$/ },
  { method: "GET", path: /^v1\/tools$/ },
  { method: "GET", path: /^v1\/principals$/ },
  { method: "GET", path: /^v1\/connections$/ },
  { method: "GET", path: /^v1\/policies$/ },
  { method: "POST", path: /^v1\/policies$/ },
  { method: "GET", path: new RegExp(`^v1/policies/${ID}$`) },
  { method: "PUT", path: new RegExp(`^v1/policies/${ID}$`) },
  { method: "GET", path: new RegExp(`^v1/policies/${ID}/versions$`) },
  { method: "POST", path: new RegExp(`^v1/policies/${ID}/(publish|retire|simulate)$`) },
  { method: "DELETE", path: new RegExp(`^v1/policies/${ID}/draft$`) },
];

/** True when this method and path (the segments after /api/nc/) are ones the Permissions module needs. */
export function isAllowedNcRequest(method: string, segments: readonly string[]): boolean {
  // A segment that could climb or split a path is refused whatever the allowlist says.
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[/\\?#%]/.test(s))) return false;
  const path = segments.join("/");
  const m = method.toUpperCase();
  return ALLOWED.some((rule) => rule.method === m && rule.path.test(path));
}

export type NcProxyDeps = { baseUrl?: string; fetch?: typeof globalThis.fetch; mode?: Mode };

const baseUrlOf = (deps: NcProxyDeps) => upstreamBase(deps);

/** Request headers worth passing on. Cookies, Authorization, Origin and Sec-Fetch-* are the browser's and stay here. */
const PASS_REQUEST = ["content-type", "accept", "idempotency-key", "if-match"];
/** Response headers worth passing back. No cookies, and nothing that describes the upstream's connection. */
const PASS_RESPONSE = ["content-type", "etag", "cache-control", "retry-after"];


/**
 * The module lists everything the mock holds. The mock also carries tools and rules of its own (the `mcp:` and
 * `ext:local:` ones), which are not Fernhill's, so the lists the module reads are cut down to Fernhill's tools and
 * the rules that name them or cover every tool (the shim enforces an `all` rule, so the screen must show it). A body that is not a JSON list is passed on untouched (returns null).
 */
export function scopeList(segments: readonly string[], text: string): string | null {
  const path = segments.join("/");
  if (path !== "v1/tools" && path !== "v1/policies") return null;
  let body: { data?: unknown } & Record<string, unknown>;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return null;
  }
  if (!Array.isArray(body.data)) return null;
  const ours = (ref: unknown) => typeof ref === "string" && ref.startsWith(OURS);
  body.data = body.data.filter((row: { tool_ref?: unknown; targets?: { tools?: unknown } }) =>
    path === "v1/tools" ? ours(row.tool_ref) : row.targets?.tools === "all" || (Array.isArray(row.targets?.tools) && row.targets.tools.some(ours)),
  );
  return JSON.stringify(body);
}

const UPSTREAM_TIMEOUT_MS = 8000;

const problem = (status: number, message: string, code = "local_noblecloak_unavailable") =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The mock's administrator token, fetched fresh each time: it changes when the mock restarts, and this is cheap and local. */
export async function adminToken(deps: NcProxyDeps = {}): Promise<string> {
  assertMock("The administrator token", deps.mode);
  const f = deps.fetch ?? globalThis.fetch;
  const res = await f(`${baseUrlOf(deps)}/__mock/tokens`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`the local mock would not issue an administrator token (HTTP ${res.status})`);
  const body = (await res.json().catch(() => null)) as { admin?: unknown } | null;
  if (typeof body?.admin !== "string" || body.admin === "") throw new Error("the local mock gave no administrator token");
  return body.admin;
}

/**
 * Forward one allowed request and return its answer. Mock mode sends it to the mock as the administrator. Deployment
 * mode sends it to the deployment with the caller's own bearer token, and answers 401 when there is none.
 */
export async function forwardToNc(request: Request, segments: readonly string[], deps: NcProxyDeps = {}): Promise<Response> {
  const mode = deps.mode ?? currentMode();
  deps = { ...deps, mode };
  if (!isAllowedNcRequest(request.method, segments)) return problem(404, "Not available through this app.");
  // Reads too: a page on another site must not be able to make this app fetch the rules as the administrator.
  // A browser that sends Sec-Fetch-Site must say same-origin; absent means a script or curl, which carries no ambient page.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return problem(403, "Cross-site request rejected.");
  const bearer = mode === "deployment" ? bearerOf(request.headers) : null;
  if (mode === "deployment" && bearer === null) return problem(401, SIGN_IN_REQUIRED.message, SIGN_IN_REQUIRED.code);
  const f = deps.fetch ?? globalThis.fetch;
  const search = new URL(request.url).search;
  let target: string;
  try {
    target = `${baseUrlOf(deps)}/${segments.map(encodeURIComponent).join("/")}${search}`;
  } catch (e) {
    if (e instanceof DeploymentConfigError) return problem(500, e.message, "deployment_not_configured");
    throw e;
  }
  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
  const body = hasBody ? await request.arrayBuffer() : undefined;
  const headers = new Headers();
  for (const name of PASS_REQUEST) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    headers.set("authorization", `Bearer ${bearer ?? (await adminToken(deps))}`);
    const upstream = await f(target, { method: request.method, headers, body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), cache: "no-store" });
    const out = new Headers();
    for (const name of PASS_RESPONSE) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    if (upstream.status === 204) return new Response(null, { status: 204, headers: out });
    const raw = await upstream.arrayBuffer();
    if (request.method.toUpperCase() === "GET" && upstream.ok) {
      const scoped = scopeList(segments, new TextDecoder().decode(raw));
      if (scoped !== null) return new Response(scoped, { status: upstream.status, headers: out });
    }
    return new Response(raw, { status: upstream.status, headers: out });
  } catch (e) {
    // Not running, or slow: say so, without the URL or any header.
    console.error(`[fernhill] NC_PROXY_FAILED ${request.method} /${segments.join("/")} ${e instanceof Error ? e.message : String(e)}`);
    return problem(502, mode === "deployment" ? "NobleCloak is not answering." : "The local NobleCloak is not answering.");
  }
}

/**
 * Mock mode only: whether Fernhill's tools are registered in the local NobleCloak. That happens when the rule proposal is approved, and
 * it stays true if every rule is later retired (the shim then answers `ask`, which the module shows, where the stub
 * would wrongly say nobody is asked). False when none are registered or the mock is down, which is the ungoverned
 * story. Read on every request, so installing and approving needs no restart.
 * Deployment mode has no server-side answer: the server holds no token. The Permissions page asks from the browser,
 * through /api/nc with the signed-in person's bearer, and reads the answer with `hasFernhillTools`.
 */
export async function hasRegisteredTools(deps: NcProxyDeps = {}): Promise<boolean> {
  assertMock("hasRegisteredTools", deps.mode);
  const f = deps.fetch ?? globalThis.fetch;
  try {
    const token = await adminToken(deps);
    const res = await f(`${baseUrlOf(deps)}/v1/tools?limit=200`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return false;
    return hasFernhillTools(await res.json());
  } catch {
    return false;
  }
}
