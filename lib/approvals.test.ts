import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalMock } from "../scripts/noblecloak-local";
import { TOOL_NAMES } from "../src/run/types";
import { fetchRunApprovals, getApproval, isUnreachable, listRunApprovals, resolveApproval, submitDecision, type ApprovalView } from "./approvals";

const BASE = "http://127.0.0.1:8787";
type Local = Awaited<ReturnType<typeof createLocalMock>>;
let local: Local;
let tokens: Awaited<ReturnType<Local["mock"]["tokens"]>>;
let sent: { method: string; url: string; body: string }[];

/** A fetch that goes to the in-process mock and records every request it saw. */
const deps = () => ({
  baseUrl: BASE,
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({ method: req.method, url: req.url, body: await req.clone().text() });
    return local.fetch(req);
  },
});

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await local.fetch(
    new Request(BASE + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  return { status: r.status, body: (await r.json()) as any };
};

const REF = (tool: string) => `ext:fernhill-desk:${tool}`;
/** Open a pending approval the way the adapter does: the creator asks for a decision on a tool whose mode is ask. */
async function openApproval(tool: string, args: Record<string, unknown>, ref = REF(tool)) {
  const reg = await call(tokens.creator, "POST", "/v1/tools", {
    tool_ref: ref, description: tool, input_schema: { type: "object" }, side_effect_level: "external", transport: "external", owner_kind: "org", show_arguments_to_approvers: true,
  });
  expect([201, 409]).toContain(reg.status);
  const d = await call(tokens.creator, "POST", "/v1/decisions", { action: { tool_ref: ref, arguments: args }, actor: {}, continuation: { kind: "langgraph", delivery: "pull", correlation: { thread_id: "t" } } });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  return { id: d.body.data.approval.id as string, digest: d.body.data.action_digest as string };
}

const CARD = { cardholder: "Maya Torres", limit_monthly: 31000, copied_from: "Dana Whitfield", account: "Mercury Ops ••4471" };
const PAYROLL = { employee: "Maya Torres", title: "Marketing Coordinator", salary_source: "copied from Dana Whitfield" };
const RUN = (startedAt: string) => ({ id: "run-1", startedAt, steps: TOOL_NAMES.map((tool) => ({ tool, status: "pending" as const })) });
const LONG_AGO = "2000-01-01T00:00:00.000Z";

beforeEach(async () => {
  local = await createLocalMock({ audience: BASE });
  tokens = await local.mock.tokens();
  sent = [];
});

describe("listRunApprovals", () => {
  it("shows the arguments the deployment returned, the waiting team from the tool, and the digest", async () => {
    const card = await openApproval("mercury_issue_card", CARD);
    const pay = await openApproval("adp_create_employee", PAYROLL);
    const views = await listRunApprovals(RUN(LONG_AGO), "priya", deps());
    const byTool = Object.fromEntries(views.map((v) => [v.tool, v]));
    expect(Object.keys(byTool).sort()).toEqual(["adp_create_employee", "mercury_issue_card"]);
    // 31000 is not the seed value (25000): the panel must be fed by what came back.
    expect(byTool.mercury_issue_card).toMatchObject({ id: card.id, waitingOn: "finance", canDecide: true, actionDigest: card.digest, args: CARD, state: "pending" });
    expect(byTool.adp_create_employee).toMatchObject({ id: pay.id, waitingOn: "hr", canDecide: true, actionDigest: pay.digest, args: PAYROLL });
  });

  it("does not show an earlier run's approvals", async () => {
    await openApproval("mercury_issue_card", CARD);
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await listRunApprovals(RUN(later), "priya", deps())).toEqual([]);
  });

  it("ignores approvals for tools that are not Fernhill Desk's nine", async () => {
    await openApproval("anything", { a: 1 }, "ext:other-app:anything");
    expect(await listRunApprovals(RUN(LONG_AGO), "priya", deps())).toEqual([]);
  });

  it("shows any of the nine with no team when a rule makes it ask", async () => {
    const slack = await openApproval("slack_invite", { email: "maya.torres@fernhill.co" });
    expect(await listRunApprovals(RUN(LONG_AGO), "priya", deps())).toMatchObject([{ id: slack.id, tool: "slack_invite", waitingOn: null, canDecide: true, args: { email: "maya.torres@fernhill.co" } }]);
  });

  it("once a step names an approval, only named approvals count, even one opened during the run", async () => {
    const card = await openApproval("mercury_issue_card", CARD);
    await openApproval("adp_create_employee", PAYROLL); // opened by something else against the same mock
    const named = { ...RUN(LONG_AGO), steps: RUN(LONG_AGO).steps.map((s) => (s.tool === "mercury_issue_card" ? { ...s, approvalId: card.id } : s)) };
    expect((await listRunApprovals(named, "priya", deps())).map((v) => v.id)).toEqual([card.id]);
  });

  it("is dormant when the mock is not running: an empty list and no console error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = { baseUrl: BASE, fetch: async () => { throw new TypeError("fetch failed"); } };
    expect(await listRunApprovals(RUN(LONG_AGO), "priya", down)).toEqual([]);
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    err.mockRestore();
    warn.mockRestore();
  });

  it("is an empty list when the run has no approvals", async () => {
    expect(await listRunApprovals(RUN(LONG_AGO), "sam", deps())).toEqual([]);
  });

  it("an idle run (no start time) has none, without calling the mock", async () => {
    expect(await listRunApprovals({ id: "", startedAt: "", steps: RUN("").steps }, "priya", deps())).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("reads the decider and the reason from resolution_history after a decision", async () => {
    const card = await openApproval("mercury_issue_card", CARD);
    const r = await resolveApproval(card.id, "deny", card.digest, "sam", "Not this month", deps());
    expect(r.ok).toBe(true);
    const [view] = await listRunApprovals(RUN(LONG_AGO), "priya", deps());
    expect(view).toMatchObject({ tool: "mercury_issue_card", state: "rejected", decision: { resolution: "rejected", by: "Sam Okoye", reason: "Not this month" } });
  });
});

describe("current-run scoping against the mock's clock", () => {
  const advance = (seconds: number) => call(tokens.creator, "POST", "/__mock/advance", { seconds });

  it("excludes an approval stamped in the future of the app's clock, unless a step names its id", async () => {
    await advance(600);
    const card = await openApproval("mercury_issue_card", CARD);
    const run = RUN(new Date().toISOString());
    expect(await listRunApprovals(run, "priya", deps())).toEqual([]);
    const named = { ...run, steps: run.steps.map((s) => (s.tool === "mercury_issue_card" ? { ...s, approvalId: card.id } : s)) };
    expect((await listRunApprovals(named, "priya", deps())).map((v) => v.id)).toEqual([card.id]);
  });
});

describe("unreachable versus empty", () => {
  const down = { baseUrl: BASE, fetch: async () => { throw new TypeError("fetch failed"); } };

  it("fetchRunApprovals says reachable:false when nothing is listening, and reachable:true with an empty list otherwise", async () => {
    expect(await fetchRunApprovals(RUN(LONG_AGO), "priya", down)).toEqual({ reachable: false, approvals: [] });
    expect(await fetchRunApprovals(RUN(LONG_AGO), "priya", deps())).toEqual({ reachable: true, approvals: [] });
  });

  it("only undici's connection failure counts as unreachable", () => {
    expect(isUnreachable(new TypeError("fetch failed"))).toBe(true);
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(isUnreachable(refused)).toBe(true);
    expect(isUnreachable(new TypeError("Cannot read properties of undefined (reading 'data')"))).toBe(false);
    expect(isUnreachable(new Error("fetch failed"))).toBe(false);
  });

  it("a programming-error TypeError is thrown, not swallowed as 'not running'", async () => {
    const buggy = { baseUrl: BASE, fetch: async () => { throw new TypeError("x is not a function"); } };
    await expect(listRunApprovals(RUN(LONG_AGO), "priya", buggy)).rejects.toThrow("x is not a function");
  });
});

describe("getApproval", () => {
  it("returns one approval with its arguments", async () => {
    const card = await openApproval("mercury_issue_card", CARD);
    expect(await getApproval(card.id, "priya", deps())).toMatchObject({ id: card.id, args: CARD });
  });
  it("is null for an id the mock does not know", async () => {
    expect(await getApproval("nope", "priya", deps())).toBeNull();
  });
});

describe("who may decide, once the rules are published", () => {
  /** Register the tool and publish the `ask` rule the demo's proposal gives it; the local mock then names Fernhill's approvers on it. */
  async function openRouted(tool: string, args: Record<string, unknown>) {
    const reg = await call(tokens.creator, "POST", "/v1/tools", {
      tool_ref: REF(tool), description: tool, input_schema: { type: "object" }, side_effect_level: "external", transport: "external", owner_kind: "org", show_arguments_to_approvers: true,
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const created = await call(tokens.admin, "POST", "/v1/policies", {
      kind: "tool_invocation", name: `rule ${tool}`, subjects: [{ type: "role", id: "everyone" }], targets: { tools: [REF(tool)] }, config: { mode: "ask" },
    });
    expect((await call(tokens.admin, "POST", `/v1/policies/${created.body.data.id as string}/publish`)).status).toBe(200);
    const d = await call(tokens.creator, "POST", "/v1/decisions", { action: { tool_ref: REF(tool), arguments: args }, actor: {}, continuation: { kind: "langgraph", delivery: "pull", correlation: { thread_id: "t" } } });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    return { id: d.body.data.approval.id as string, digest: d.body.data.action_digest as string };
  }

  it("Priya may decide the card and not payroll; Sam the reverse; the other one's arguments are withheld", async () => {
    const card = await openRouted("mercury_issue_card", CARD);
    const pay = await openRouted("adp_create_employee", PAYROLL);
    const asPriya = Object.fromEntries((await listRunApprovals(RUN(LONG_AGO), "priya", deps())).map((v) => [v.id, v]));
    expect(asPriya[card.id]).toMatchObject({ canDecide: true, waitingOn: "finance", args: CARD });
    expect(asPriya[pay.id]).toMatchObject({ canDecide: false, waitingOn: "hr" });
    expect(asPriya[pay.id]!.args).toBeUndefined();
    const asSam = Object.fromEntries((await listRunApprovals(RUN(LONG_AGO), "sam", deps())).map((v) => [v.id, v]));
    expect(asSam[pay.id]).toMatchObject({ canDecide: true, args: PAYROLL });
    expect(asSam[card.id]).toMatchObject({ canDecide: false });
    expect(asSam[card.id]!.args).toBeUndefined();
  });

  it("a decision from the wrong team is a 403 failure result and decides nothing", async () => {
    const pay = await openRouted("adp_create_employee", PAYROLL);
    for (const decision of ["approve", "deny"] as const) {
      const r = await resolveApproval(pay.id, decision, pay.digest, "priya", undefined, deps());
      expect(r).toMatchObject({ ok: false, status: 403 });
      expect(r.ok === false && r.message).toMatch(/cannot resolve/);
    }
    expect((await getApproval(pay.id, "sam", deps()))?.state).toBe("pending");
    expect((await resolveApproval(pay.id, "approve", pay.digest, "sam", undefined, deps())).ok).toBe(true);
  });
});

describe("resolveApproval", () => {
  it("sends expected_action_digest, the resolution and the reason, as the chosen persona", async () => {
    const card = await openApproval("mercury_issue_card", CARD);
    const r = await resolveApproval(card.id, "approve", card.digest, "priya", undefined, deps());
    expect(r.ok).toBe(true);
    const post = sent.find((s) => s.method === "POST" && s.url.endsWith(`/v1/approvals/${card.id}/resolve`));
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body)).toMatchObject({ resolution: "approved", expected_action_digest: card.digest });
    const after = (await call(tokens.admin, "GET", `/v1/approvals/${card.id}`)).body.data;
    expect(after.resolution_history[0].by).toMatchObject({ id: "user_priya_shah", display_name: "Priya Shah" });
  });

  it("a deny carries the reason", async () => {
    const card = await openApproval("mercury_issue_card", CARD);
    await resolveApproval(card.id, "deny", card.digest, "sam", "Over budget", deps());
    const post = sent.find((s) => s.url.endsWith("/resolve"))!;
    expect(JSON.parse(post.body)).toMatchObject({ resolution: "rejected", reason: "Over budget" });
  });

  it("a stale digest is a 409 failure result, not a throw", async () => {
    const card = await openApproval("mercury_issue_card", CARD);
    const r = await resolveApproval(card.id, "approve", "0".repeat(64), "priya", undefined, deps());
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("any other 403 carries the server's own words", async () => {
    const forbidden = {
      baseUrl: BASE,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new Request(input, init).url;
        if (url.includes("/__demo/token")) return new Response(JSON.stringify({ token: "t" }), { status: 200 });
        return new Response(JSON.stringify({ title: "Principal is not eligible", status: 403, detail: "A user who may not approve cannot resolve it." }), { status: 403, headers: { "content-type": "application/problem+json" } });
      },
    };
    const r = await resolveApproval("a", "approve", "d", "priya", undefined, forbidden);
    expect(r).toEqual({ ok: false, status: 403, message: "A user who may not approve cannot resolve it." });
  });
});

describe("submitDecision (the browser side)", () => {
  const approval: ApprovalView = { id: "a1", tool: "mercury_issue_card", args: CARD, waitingOn: "finance", canDecide: true, actionDigest: "dig", state: "pending" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("posts the digest from the approval on screen", async () => {
    const f = vi.fn(async () => reply(200, { ok: true }));
    const refetch = vi.fn(async () => {});
    await submitDecision(approval, "approve", undefined, refetch, f as never);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/approvals/a1/resolve");
    expect(JSON.parse(init.body as string)).toEqual({ decision: "approve", expectedActionDigest: "dig" });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a 409 gives an inline message and refetches", async () => {
    const f = vi.fn(async () => reply(409, { ok: false, status: 409, message: "x" }));
    const refetch = vi.fn(async () => {});
    const out = await submitDecision(approval, "deny", "No", refetch, f as never);
    expect(out).toMatch(/changed or was already decided/i);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("another 403 shows the server's message inline", async () => {
    const f = vi.fn(async () => reply(403, { ok: false, status: 403, message: "Not eligible." }));
    const out = await submitDecision(approval, "approve", undefined, vi.fn(async () => {}), f as never);
    expect(out).toBe("Not eligible.");
  });

  it("a network failure shows a message and does not throw", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const out = await submitDecision(approval, "approve", undefined, vi.fn(async () => {}), f as never);
    expect(out).toMatch(/could not/i);
  });
});
