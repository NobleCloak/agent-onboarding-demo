import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listGet } from "../app/api/approvals/route";
import { POST as resolvePost } from "../app/api/approvals/[id]/resolve/route";
import { GET as personaGet, POST as personaPost } from "../app/api/persona/route";
import { createLocalMock } from "../scripts/noblecloak-local";
import { closeStore, startRun } from "../src/run/store";

const BASE = "http://127.0.0.1:8787";
type Local = Awaited<ReturnType<typeof createLocalMock>>;
let local: Local;
let dir: string;
let minted: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fernhill-routes-"));
  process.env.FERNHILL_DATA_DIR = dir;
  local = await createLocalMock({ audience: BASE });
  minted = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await local.fetch(new Request(input, init));
    if (new URL(res.url || BASE).pathname === "/__demo/token" || (typeof input === "string" && input.includes("/__demo/token"))) {
      minted.push(((await res.clone().json()) as { token: string }).token);
    }
    return res;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  closeStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FERNHILL_DATA_DIR;
});

const withCookie = (persona: string) => ({ headers: { cookie: `fernhill_persona=${persona}` } });
const REF = "ext:fernhill-desk:mercury_issue_card";
async function openCard() {
  const tokens = await local.mock.tokens();
  const call = (m: string, p: string, b: unknown) =>
    local.fetch(new Request(BASE + p, { method: m, headers: { authorization: `Bearer ${tokens.creator}`, "content-type": "application/json" }, body: JSON.stringify(b) }));
  await call("POST", "/v1/tools", { tool_ref: REF, description: "card", input_schema: { type: "object" }, side_effect_level: "external", transport: "external", owner_kind: "org", show_arguments_to_approvers: true });
  const d = (await (await call("POST", "/v1/decisions", { action: { tool_ref: REF, arguments: { cardholder: "Maya Torres", limit_monthly: 25000, copied_from: "Dana Whitfield" } }, actor: {} })).json()) as any;
  return { id: d.data.approval.id as string, digest: d.data.action_digest as string };
}

describe("/api/persona", () => {
  it("defaults to Priya and switches with a cookie that holds the key only", async () => {
    expect(await (await personaGet(new Request("http://x/api/persona"))).json()).toMatchObject({ persona: "priya", displayName: "Priya Shah" });
    const res = await personaPost(new Request("http://x/api/persona", { method: "POST", body: JSON.stringify({ persona: "sam" }) }));
    expect(await res.json()).toMatchObject({ persona: "sam", displayName: "Sam Okoye" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("fernhill_persona=sam");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(await (await personaGet(new Request("http://x/api/persona", withCookie("sam")))).json()).toMatchObject({ persona: "sam" });
  });
  it("rejects a persona that does not exist", async () => {
    const res = await personaPost(new Request("http://x/api/persona", { method: "POST", body: JSON.stringify({ persona: "admin" }) }));
    expect(res.status).toBe(400);
  });
});

describe("/api/approvals", () => {
  it("lists the current run's approvals and no response carries a token", async () => {
    startRun();
    const card = await openCard();
    const list = await listGet(new Request("http://x/api/approvals", withCookie("sam")));
    const text = await list.text();
    expect(JSON.parse(text)).toMatchObject({ persona: "sam", approvals: [{ id: card.id, tool: "mercury_issue_card", waitingOn: "finance", args: { limit_monthly: 25000 } }] });
    expect(minted.length).toBeGreaterThan(0);
    for (const t of minted) expect(text).not.toContain(t);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    for (const res of [await personaGet(new Request("http://x/api/persona")), await personaPost(new Request("http://x/api/persona", { method: "POST", body: JSON.stringify({ persona: "priya" }) }))]) {
      const body = await res.text();
      expect(body).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(body.toLowerCase()).not.toContain("token");
    }
  });

  it("is dormant with no run: an empty list", async () => {
    const list = await listGet(new Request("http://x/api/approvals"));
    expect(await list.json()).toMatchObject({ approvals: [] });
  });

  it("reports reachable:true for an empty list and reachable:false when the mock is down", async () => {
    startRun();
    expect(await (await listGet(new Request("http://x/api/approvals"))).json()).toMatchObject({ approvals: [], reachable: true });
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    expect(await (await listGet(new Request("http://x/api/approvals"))).json()).toMatchObject({ approvals: [], reachable: false });
  });

  it("logs a failing response from something else on the port once per state change, not on every poll", async () => {
    startRun();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    for (let i = 0; i < 5; i++) expect((await listGet(new Request("http://x/api/approvals"))).status).toBe(502);
    expect(err).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", real); // recovers
    expect((await listGet(new Request("http://x/api/approvals"))).status).toBe(200);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await listGet(new Request("http://x/api/approvals"));
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("is dormant when the mock is not running: an empty list, 200, no console error", async () => {
    startRun();
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const list = await listGet(new Request("http://x/api/approvals"));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ approvals: [] });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("/api/approvals/[id]/resolve", () => {
  const post = (id: string, body: unknown, persona = "priya") =>
    resolvePost(new Request(`http://x/api/approvals/${id}/resolve`, { method: "POST", body: JSON.stringify(body), ...withCookie(persona) }), { params: Promise.resolve({ id }) });

  it("records the decision as the persona in the cookie and returns only the outcome", async () => {
    startRun();
    const card = await openCard();
    const res = await post(card.id, { decision: "deny", expectedActionDigest: card.digest, reason: "Not this month" }, "sam");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true });
    const listed = await (await listGet(new Request("http://x/api/approvals", withCookie("priya")))).json();
    expect(listed.approvals[0]).toMatchObject({ state: "rejected", decision: { by: "Sam Okoye", reason: "Not this month" } });
  });

  it("a stale digest is a 409 with a message", async () => {
    startRun();
    const card = await openCard();
    const res = await post(card.id, { decision: "approve", expectedActionDigest: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, status: 409 });
  });

  it("a body without a digest is a 400", async () => {
    expect((await post("x", { decision: "approve" })).status).toBe(400);
  });
});
