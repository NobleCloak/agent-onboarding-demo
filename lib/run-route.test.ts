import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../src/agent/start", () => ({ startAgentRun: vi.fn(async () => undefined) }));
vi.mock("../src/run/sync", () => ({ syncParkedRun: async (deps: unknown) => void sync.calls.push(deps) }));

import { DELETE, GET, POST } from "../app/api/run/route";
import { getRun, setRunState, setStep, startRun, closeStore } from "../src/run/store";

let dir: string;
beforeEach(() => {
  sync.calls = [];
  dir = mkdtempSync(join(tmpdir(), "fernhill-run-route-"));
  process.env.FERNHILL_DATA_DIR = dir;
});
afterEach(() => {
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const DEPLOYMENT = "https://govern.noblecloak.com";
/** A deployment that accepts only the token `good`. */
function deployment() {
  vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
  vi.stubEnv("NC_BASE_URL", DEPLOYMENT);
  vi.stubEnv("NEXT_PUBLIC_NC_API_URL", DEPLOYMENT);
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    seen.push(`${r.headers.get("authorization")} ${new URL(r.url).pathname}`);
    return r.headers.get("authorization") === "Bearer good" ? Response.json({ data: [] }) : Response.json({ error: "no" }, { status: 401 });
  });
  return seen;
}

const req = (authorization?: string) => new Request("http://localhost/api/run", { headers: authorization ? { authorization } : {} });

describe("GET /api/run", () => {
  it("mock mode: syncs with the old, empty deps", async () => {
    await GET(req());
    expect(sync.calls).toEqual([{}]);
  });
  it("deployment mode: a token the deployment accepts is handed to the sync and the run is returned with its steps", async () => {
    const seen = deployment();
    const res = await GET(req("Bearer good"));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("steps");
    expect(sync.calls).toEqual([{ mode: "deployment", bearer: "good" }]);
    expect(seen).toEqual(["Bearer good /v1/approvals"]);
  });
  it("deployment mode: a made-up bearer that the deployment answers 401 gets 401, no run body and no sync (nothing parked or not)", async () => {
    deployment();
    const res = await GET(req("Bearer x"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: 401 });
    expect(body).not.toHaveProperty("steps");
    expect(sync.calls).toEqual([]);
  });
  it("deployment mode: a deployment that cannot be reached gives 502 and no run body, never the run", async () => {
    deployment();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const res = await GET(req("Bearer good"));
    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty("steps");
    expect(sync.calls).toEqual([]);
  });
  it("deployment mode with no bearer is refused 401: nothing synced and no run body, so a cached decision read with someone's token is not handed out", async () => {
    vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
    const res = await GET(req());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: 401 });
    expect(body).not.toHaveProperty("steps");
    expect(sync.calls).toEqual([]);
  });
});

describe("GET /api/run decision detail in deployment mode", () => {
  const RAW = {
    id: "ap-card",
    state: "rejected",
    tool_ref: "ext:fernhill-desk:mercury_issue_card",
    action_digest: "d",
    created_at: "2026-11-03T10:00:00.000Z",
    resolution_history: [{ resolution: "rejected", by: { id: "u", display_name: "Sam Okoye" }, at: "2026-11-03T10:01:00.000Z", reason: "Not this month" }],
  };
  /** Two people's tokens: `a` may read the approval, `b` is signed in but its read of the approval is refused (or finds nothing). */
  function twoTokens(refusedWith: 403 | 404) {
    vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
    vi.stubEnv("NC_BASE_URL", DEPLOYMENT);
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", DEPLOYMENT);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      const token = r.headers.get("authorization");
      if (token !== "Bearer a" && token !== "Bearer b") return Response.json({}, { status: 401 });
      if (new URL(r.url).pathname === "/v1/approvals") return Response.json({ data: [] });
      return token === "Bearer a" ? Response.json({ data: RAW }) : Response.json({}, { status: refusedWith });
    });
  }
  /** What a mock-mode sync (or an older build) left in the shared store: the decision, already on the step. */
  function storedDecision() {
    const run = startRun()!;
    setRunState(run.id, "parked");
    setStep(run.id, "mercury_issue_card", { status: "denied", approvalId: "ap-card", reason: "Not this month", decidedBy: "Sam Okoye", resolution: "rejected" });
  }
  const card = async (res: Response) => ((await res.json()) as { steps: { tool: string }[] }).steps.find((s) => s.tool === "mercury_issue_card")!;

  for (const refused of [403, 404] as const) {
    it(`a token whose own read of the approval is ${refused} is not given the stored decision`, async () => {
      twoTokens(refused);
      storedDecision();
      expect(await card(await GET(req("Bearer b")))).toEqual({ tool: "mercury_issue_card", status: "denied", approvalId: "ap-card" });
    });
  }
  it("a token whose own read succeeds gets who decided and why", async () => {
    twoTokens(403);
    storedDecision();
    expect(await card(await GET(req("Bearer a")))).toMatchObject({ decidedBy: "Sam Okoye", resolution: "rejected", reason: "Not this month" });
  });
  it("mock mode serves the stored decision as before", async () => {
    storedDecision();
    expect(await card(await GET(req()))).toMatchObject({ decidedBy: "Sam Okoye", resolution: "rejected" });
    expect(getRun().state).toBe("parked");
  });
});

describe("POST and DELETE /api/run in deployment mode", () => {
  const send = (method: "POST" | "DELETE", authorization?: string) => new Request("http://localhost/api/run", { method, headers: authorization ? { authorization } : {} });
  const handlers = { POST, DELETE };

  for (const method of ["POST", "DELETE"] as const) {
    it(`${method}: no bearer is 401 and changes nothing`, async () => {
      deployment();
      const res = await handlers[method](send(method));
      expect(res.status).toBe(401);
      expect(getRun().state).toBe("idle");
    });
    it(`${method}: a bearer the deployment rejects is 401 and changes nothing`, async () => {
      const seen = deployment();
      const res = await handlers[method](send(method, "Bearer bogus"));
      expect(res.status).toBe(401);
      expect(seen).toEqual(["Bearer bogus /v1/approvals"]);
      expect(getRun().state).toBe("idle");
    });
  }
  it("POST with a good bearer starts the run (202)", async () => {
    deployment();
    const res = await POST(send("POST", "Bearer good"));
    expect(res.status).toBe(202);
    expect(getRun().state).toBe("running");
  });
  it("DELETE with a good bearer resets the run (200)", async () => {
    deployment();
    expect((await POST(send("POST", "Bearer good"))).status).toBe(202);
    const res = await DELETE(send("DELETE", "Bearer good"));
    expect(res.status).toBe(200);
    expect(getRun().state).toBe("idle");
  });
  it("mock mode: POST and DELETE ask for nothing", async () => {
    expect((await POST(send("POST"))).status).toBe(202);
    expect((await DELETE(send("DELETE"))).status).toBe(200);
  });
});
