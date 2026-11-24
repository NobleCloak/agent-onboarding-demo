import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listGet } from "../app/api/approvals/route";
import { POST as resolvePost } from "../app/api/approvals/[id]/resolve/route";
import { GET as ncGet, POST as ncPost } from "../app/api/nc/[...path]/route";
import { GET as personaGet, POST as personaPost } from "../app/api/persona/route";
import { POST as approvePost } from "../app/api/proposal/[id]/approve/route";
import { GET as proposalGet } from "../app/api/proposal/route";
import { createLocalMock } from "../scripts/noblecloak-local";
import { closeStore, startRun } from "../src/run/store";
import { fetchRunApprovals, getApproval, resolveApproval } from "./approvals";
import { adminToken, forwardToNc, hasRegisteredTools } from "./nc-proxy";
import { PROPOSE_REF, approveProposal, readProposal } from "./proposal";

// Deployment mode, end to end against the NobleCloak engine standing in for a deployment at https://govern.test.
// The app only ever sees `deployment`, a fetch that records every request, and refuses any path of the mock's own.

const BASE = "http://127.0.0.1:8787";
const DEPLOYMENT = "https://govern.test";
const REF = "ext:fernhill-desk:mercury_issue_card";
type Local = Awaited<ReturnType<typeof createLocalMock>>;
let local: Local;
let dir: string;
let requests: { method: string; url: URL; headers: Headers }[];
let personToken: string;
let adminTokenValue: string;

/** The deployment, as the app can reach it: /v1 routes only. The mock's own routes do not exist there. */
const deploymentFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  requests.push({ method: request.method, url, headers: request.headers });
  if (url.pathname.startsWith("/__mock") || url.pathname.startsWith("/__demo") || url.origin !== DEPLOYMENT) {
    throw new Error(`the mock was contacted: ${request.method} ${request.url}`);
  }
  return local.fetch(new Request(BASE + url.pathname + url.search, request));
}) as typeof fetch;

const asPerson = (extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${personToken}`, ...extra } });
/** The administrator who signed in: the rule proposal's arguments are shown to an administrator only. */
const asAdmin = () => ({ headers: { authorization: `Bearer ${adminTokenValue}` } });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fernhill-deployment-"));
  process.env.FERNHILL_DATA_DIR = dir;
  vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
  vi.stubEnv("NC_BASE_URL", DEPLOYMENT);
  vi.stubEnv("NEXT_PUBLIC_NC_API_URL", DEPLOYMENT);
  local = await createLocalMock({ audience: BASE });
  // The person who signed in. Minted here by the test fixture straight from the engine, never through the app.
  personToken = ((await (await local.fetch(new Request(`${BASE}/__demo/token?as=priya`))).json()) as { token: string }).token;
  adminTokenValue = (await local.mock.tokens()).admin;
  requests = [];
  vi.stubGlobal("fetch", deploymentFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
});

async function openCard() {
  const tokens = await local.mock.tokens();
  const call = (m: string, p: string, b: unknown) =>
    local.fetch(new Request(BASE + p, { method: m, headers: { authorization: `Bearer ${tokens.creator}`, "content-type": "application/json" }, body: JSON.stringify(b) }));
  await call("POST", "/v1/tools", { tool_ref: REF, description: "card", input_schema: { type: "object" }, side_effect_level: "external", transport: "external", owner_kind: "org", show_arguments_to_approvers: true });
  const d = (await (await call("POST", "/v1/decisions", { action: { tool_ref: REF, arguments: { cardholder: "Maya Torres", limit_monthly: 25000 } }, actor: {} })).json()) as any;
  return { id: d.data.approval.id as string, digest: d.data.action_digest as string };
}

async function openProposal() {
  const tokens = await local.mock.tokens();
  const call = async (m: string, p: string, b?: unknown, h: Record<string, string> = {}) =>
    (await local.fetch(new Request(BASE + p, { method: m, headers: { authorization: `Bearer ${tokens.creator_user}`, "content-type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) }))).json() as Promise<any>;
  const agent = await call("POST", "/v1/agents", { name: "Fernhill Desk" }, { "idempotency-key": crypto.randomUUID() });
  const plan = JSON.parse(readFileSync("demo/rules.plan.json", "utf8"));
  const opened = await call("POST", "/v1/approvals", {
    action: {
      tool_ref: PROPOSE_REF,
      arguments: {
        agent: { id: agent.data.id, principal_id: "svc_adapter" },
        tools: plan.tools.map((t: object) => ({ owner_kind: "org", transport: "external", ...t })),
        policies: plan.policies.map((p: any) => ({ role: p.role, rationale: p.rationale, assessment: p.assessment, policy: { kind: "tool_invocation", subjects: [{ type: "role", id: "everyone" }], targets: { tools: [p.tool] }, config: { mode: p.mode } } })),
      },
    },
    continuation: { kind: "mcp_held", delivery: "held" },
  });
  if (!opened.data) throw new Error(JSON.stringify(opened));
  return { id: opened.data.id as string, digest: opened.data.action_digest as string };
}

const touchedMock = () => requests.filter((r) => /^\/__(mock|demo)/.test(r.url.pathname) || r.url.origin !== DEPLOYMENT);

describe("deployment mode never contacts the mock", () => {
  it("uses only the deployment's own routes through every server entry point", async () => {
    startRun();
    const proposal = await openProposal();
    const card = await openCard();
    requests = [];
    const run = { id: "r", startedAt: new Date(0).toISOString(), steps: [] };
    const bearer = { mode: "deployment" as const, bearer: personToken };

    await fetchRunApprovals(run, "priya", bearer);
    await getApproval(card.id, "sam", bearer);
    await readProposal({ ...bearer, bearer: adminTokenValue });
    await ncGet(new Request("http://127.0.0.1:3417/api/nc/v1/tools", asPerson()), { params: Promise.resolve({ path: ["v1", "tools"] }) });
    await ncGet(new Request("http://127.0.0.1:3417/api/nc/v1/policies", asPerson()), { params: Promise.resolve({ path: ["v1", "policies"] }) });
    await listGet(new Request("http://x/api/approvals", asPerson({ cookie: "fernhill_persona=sam" })));
    await proposalGet(new Request("http://x/api/proposal", asAdmin()));
    await resolvePost(new Request("http://x/api/approvals/x/resolve", { method: "POST", ...asPerson(), body: JSON.stringify({ decision: "approve", expectedActionDigest: "stale" }) }), { params: Promise.resolve({ id: card.id }) });
    await approvePost(new Request("http://x/api/proposal/x/approve", { method: "POST", ...asAdmin(), body: JSON.stringify({ expectedActionDigest: "stale" }) }), { params: Promise.resolve({ id: proposal.id }) });

    expect(requests.length).toBeGreaterThan(8); // the setup above would pass trivially if nothing was sent
    expect(requests.some((r) => r.url.pathname === "/v1/approvals")).toBe(true);
    expect(touchedMock().map((r) => r.url.href)).toEqual([]);
  });

  it("the mock-only helpers refuse before any request leaves", async () => {
    await expect(adminToken({ mode: "deployment", fetch: deploymentFetch })).rejects.toThrow(/mock only/);
    await expect(hasRegisteredTools({ mode: "deployment", fetch: deploymentFetch })).rejects.toThrow(/mock only/);
    expect(requests).toEqual([]);
  });

  it("no source under app/, components/ or lib/ outside the mock-mode helpers names a mock route", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(p);
      }
    };
    for (const root of ["app", "components", "lib"]) walk(root);
    const named = files.filter((f) => /__mock|__demo/.test(readFileSync(f, "utf8"))).sort();
    // Each of these reaches the mock only behind assertMock (the helper tests above prove the guard).
    expect(named).toEqual(["lib/approvals.ts", "lib/nc-proxy.ts", "lib/proposal.ts"]);
  });

  it("no code the web process runs reads the agent's service-principal credential", () => {
    for (const f of ["lib/approvals.ts", "lib/proposal.ts", "lib/nc-proxy.ts", "lib/route-auth.ts", "lib/mode.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/NOBLECLOAK_SP_CREDENTIALS|credentials\.json/);
    }
  });
});

describe("/api/nc in deployment mode", () => {
  const ctx = { params: Promise.resolve({ path: ["v1", "tools"] }) };
  const url = "http://127.0.0.1:3417/api/nc/v1/tools";

  it("answers 401 without a bearer and sends nothing upstream", async () => {
    const res = await ncGet(new Request(url), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "sign_in_required" } });
    expect(requests).toEqual([]);
  });

  it("forwards the caller's bearer and only the allowed headers: no cookie, no persona, no fetched token", async () => {
    await ncGet(new Request(url, { headers: { authorization: `Bearer ${personToken}`, cookie: "fernhill_persona=sam; session=abc", accept: "application/json", "x-actor-id": "evil", origin: "http://localhost:3417" } }), ctx);
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.url.href).toBe(`${DEPLOYMENT}/v1/tools`);
    expect(sent.headers.get("authorization")).toBe(`Bearer ${personToken}`);
    expect(sent.headers.get("cookie")).toBeNull();
    expect(sent.headers.get("x-actor-id")).toBeNull();
    expect(sent.headers.get("accept")).toBe("application/json");
  });

  it("keeps the allowlist and the cross-site refusal", async () => {
    expect((await forwardToNc(new Request("http://x/api/nc/v1/approvals", asPerson()), ["v1", "approvals"], { mode: "deployment" })).status).toBe(404);
    const cross = await ncPost(new Request("http://x/api/nc/v1/policies", { method: "POST", headers: { authorization: `Bearer ${personToken}`, "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["v1", "policies"] }) });
    expect(cross.status).toBe(403);
    expect(requests).toEqual([]);
  });

  it("still narrows the lists to Fernhill's tools", async () => {
    await openCard();
    const res = await ncGet(new Request(url, asPerson()), ctx);
    const rows = ((await res.json()) as { data: { tool_ref: string }[] }).data;
    expect(rows.map((r) => r.tool_ref)).toEqual([REF]);
  });

  it("says the setting is missing, loudly, when NC_BASE_URL is not set, and does not fall back to the mock", async () => {
    vi.stubEnv("NC_BASE_URL", undefined);
    const res = await ncGet(new Request(url, asPerson()), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "deployment_not_configured", message: expect.stringContaining("NC_BASE_URL") } });
    expect(requests).toEqual([]);
  });

  it("passes the deployment's own refusal of a token through", async () => {
    const res = await ncGet(new Request(url, { headers: { authorization: "Bearer not-a-token" } }), ctx);
    expect(res.status).toBe(401);
    expect(requests).toHaveLength(1);
  });
});

describe("/api/approvals and /api/proposal in deployment mode", () => {
  it("answer 401 without a bearer, before any request leaves", async () => {
    startRun();
    const bodies = JSON.stringify({ decision: "approve", expectedActionDigest: "d" });
    const ctx = { params: Promise.resolve({ id: "x" }) };
    for (const res of [
      await listGet(new Request("http://x/api/approvals", { headers: { cookie: "fernhill_persona=sam" } })),
      await resolvePost(new Request("http://x/api/approvals/x/resolve", { method: "POST", body: bodies }), ctx),
      await proposalGet(new Request("http://x/api/proposal")),
      await approvePost(new Request("http://x/api/proposal/x/approve", { method: "POST", body: JSON.stringify({ expectedActionDigest: "d" }) }), ctx),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, status: 401, message: expect.stringContaining("Sign in") });
    }
    expect(requests).toEqual([]);
  });

  it("list the run's approvals as the signed-in person; the persona cookie changes nothing", async () => {
    startRun();
    const card = await openCard();
    const asSam = await (await listGet(new Request("http://x/api/approvals", asPerson({ cookie: "fernhill_persona=sam" })))).json();
    const plain = await (await listGet(new Request("http://x/api/approvals", asPerson()))).json();
    expect(asSam).toEqual(plain);
    expect(plain).toMatchObject({ reachable: true, approvals: [{ id: card.id, tool: "mercury_issue_card" }] });
    expect(plain).not.toHaveProperty("persona");
    expect(plain).not.toHaveProperty("displayName");
    for (const r of requests) expect(r.headers.get("authorization")).toBe(`Bearer ${personToken}`);
    for (const r of requests) expect(r.headers.get("cookie")).toBeNull();
  });

  it("idle: a token the deployment refuses is 401, not an empty list; an accepted one gets an empty list with no persona", async () => {
    const bad = await listGet(new Request("http://x/api/approvals", { headers: { authorization: "Bearer not-a-token" } }));
    expect(bad.status).toBe(401);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/approvals"]);
    requests.length = 0;
    const good = await listGet(new Request("http://x/api/approvals", asPerson()));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ reachable: true, approvals: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${personToken}`);
  });

  it("resolve an approval with the person's token", async () => {
    startRun();
    const card = await openCard();
    const res = await resolvePost(new Request("http://x/api/approvals/x/resolve", { method: "POST", ...asPerson({ cookie: "fernhill_persona=sam" }), body: JSON.stringify({ decision: "approve", expectedActionDigest: card.digest }) }), { params: Promise.resolve({ id: card.id }) });
    expect(res.status).toBe(200);
    const after = await getApproval(card.id, "priya", { mode: "deployment", bearer: personToken, fetch: deploymentFetch });
    expect(after).toMatchObject({ state: "approved", decision: { resolution: "approved" } });
  });

  it("read and approve the rule proposal with the person's token", async () => {
    const p = await openProposal();
    const read = await (await proposalGet(new Request("http://x/api/proposal", asAdmin()))).json();
    expect(read).toMatchObject({ reachable: true, proposal: { id: p.id, state: "pending" } });
    const res = await approvePost(new Request("http://x/api/proposal/x/approve", { method: "POST", ...asAdmin(), body: JSON.stringify({ expectedActionDigest: read.proposal.actionDigest }) }), { params: Promise.resolve({ id: p.id }) });
    expect(await res.json()).toEqual({ ok: true });
    for (const r of requests) expect(r.headers.get("authorization")).toBe(`Bearer ${adminTokenValue}`);
  });

  it("pass a refused token on as 401 so the page can ask for a sign-in, not as an empty list", async () => {
    startRun();
    const bad = { headers: { authorization: "Bearer not-a-token" } };
    expect((await listGet(new Request("http://x/api/approvals", bad))).status).toBe(401);
    expect((await proposalGet(new Request("http://x/api/proposal", bad))).status).toBe(401);
  });

  it("the lib functions need the bearer themselves, so no caller can fall back to a token of this server's own", async () => {
    const run = { id: "r", startedAt: new Date(0).toISOString(), steps: [] };
    await expect(fetchRunApprovals(run, "priya", { mode: "deployment", fetch: deploymentFetch })).rejects.toMatchObject({ status: 401 });
    await expect(resolveApproval("a", "approve", "d", "priya", undefined, { mode: "deployment", fetch: deploymentFetch })).rejects.toMatchObject({ status: 401 });
    await expect(approveProposal("a", "d", { mode: "deployment", fetch: deploymentFetch })).rejects.toMatchObject({ status: 401 });
    expect(requests).toEqual([]);
  });

  it("report a missing NC_BASE_URL as a configuration error, never as the mock", async () => {
    vi.stubEnv("NC_BASE_URL", undefined);
    startRun();
    const res = await listGet(new Request("http://x/api/approvals", asPerson()));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("NC_BASE_URL") });
    expect(requests).toEqual([]);
  });
});

describe("/api/persona in deployment mode", () => {
  it("is not available: the signed-in person is the approver", async () => {
    expect((await personaGet(new Request("http://x/api/persona", { headers: { cookie: "fernhill_persona=sam" } }))).status).toBe(404);
    const res = await personaPost(new Request("http://x/api/persona", { method: "POST", body: JSON.stringify({ persona: "sam" }) }));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
