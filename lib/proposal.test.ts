import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalMock } from "../scripts/noblecloak-local";
import { approveProposal, isApprovable, readProposal, toProposal } from "./proposal";

const BASE = "http://127.0.0.1:8787";
type Local = Awaited<ReturnType<typeof createLocalMock>>;
let local: Local;
let tokens: Awaited<ReturnType<Local["mock"]["tokens"]>>;

const deps = () => ({ baseUrl: BASE, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => local.fetch(new Request(input, init))) as typeof fetch });

const call = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await local.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as any };
};

const plan = JSON.parse(readFileSync("demo/rules.plan.json", "utf8"));
/** The plans two fresh Claude sessions wrote from the skill's rubric, unedited. */
const freshPlan = JSON.parse(readFileSync("lib/fixtures/fresh-plan-1.json", "utf8"));
const freshPlan2 = JSON.parse(readFileSync("lib/fixtures/fresh-plan-2.json", "utf8"));
/** The arguments `propose.mjs` builds from a plan. */
const argsOf = (p: any, agentId = "a") => ({
  agent: { id: agentId, principal_id: p.agent.principal_id },
  tools: p.tools.map((t: object) => ({ owner_kind: "org", transport: "external", ...t })),
  policies: p.policies.map((e: any) => ({ role: e.role, rationale: e.rationale, assessment: e.assessment, policy: { kind: "tool_invocation", subjects: [{ type: "role", id: "everyone" }], targets: { tools: [e.tool] }, config: { mode: e.mode } } })),
});

/** What propose.mjs sends: declare the agent, then open the approval as a person. */
async function propose() {
  const agent = await call(tokens.creator_user, "POST", "/v1/agents", { name: "Fernhill Desk" }, { "idempotency-key": crypto.randomUUID() });
  const opened = await call(tokens.creator_user, "POST", "/v1/approvals", {
    action: {
      tool_ref: "tool:noblecloak:propose-policy-set",
      arguments: {
        agent: { id: agent.body.data.id, principal_id: "svc_adapter" },
        tools: plan.tools.map((t: object) => ({ owner_kind: "org", transport: "external", ...t })),
        policies: plan.policies.map((p: any) => ({ role: p.role, rationale: p.rationale, assessment: p.assessment, policy: { kind: "tool_invocation", subjects: [{ type: "role", id: "everyone" }], targets: { tools: [p.tool] }, config: { mode: p.mode } } })),
      },
    },
    continuation: { kind: "mcp_held", delivery: "held" },
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body.data.id as string;
}

beforeEach(async () => {
  local = await createLocalMock({ audience: BASE });
  tokens = await local.mock.tokens();
});

describe("readProposal", () => {
  it("is dormant on a mock with no proposal", async () => {
    expect(await readProposal(deps())).toEqual({ reachable: true, proposal: null });
  });

  it("mock mode: a refused list is an empty, reachable panel, as before (no throw)", async () => {
    const real = deps().fetch;
    const refused = { baseUrl: BASE, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (new Request(input, init).url.includes("/v1/approvals") ? new Response("{}", { status: 403 }) : real(input, init))) as typeof fetch };
    expect(await readProposal(refused)).toEqual({ reachable: true, proposal: null });
  });

  it("is dormant and says unreachable when nothing is listening", async () => {
    const down = { baseUrl: BASE, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch };
    expect(await readProposal(down)).toEqual({ reachable: false, proposal: null });
  });

  it("shows the pending proposal's tools, modes and rationale from what the deployment returned", async () => {
    const id = await propose();
    const { proposal } = await readProposal(deps());
    expect(proposal).toMatchObject({ id, state: "pending" });
    expect(proposal?.rules).toHaveLength(9);
    expect(proposal?.rules.filter((r) => r.mode === "always_allow")).toHaveLength(6);
    expect(proposal?.rules.filter((r) => r.mode === "ask").map((r) => r.tool).sort()).toEqual(["adp_create_employee", "mercury_issue_card"]);
    expect(proposal?.rules.find((r) => r.mode === "deny")).toMatchObject({ tool: "okta_assign_admin_role", rationale: expect.stringContaining("never") });
  });

  it("ignores the agent's own tool approvals", async () => {
    await call(tokens.creator, "POST", "/v1/tools", { tool_ref: "ext:fernhill-desk:slack_invite", description: "x", input_schema: { type: "object" }, side_effect_level: "external", transport: "external", owner_kind: "org", show_arguments_to_approvers: true });
    await call(tokens.creator, "POST", "/v1/decisions", { action: { tool_ref: "ext:fernhill-desk:slack_invite", arguments: {} }, actor: {}, continuation: { kind: "langgraph", delivery: "pull", correlation: { thread_id: "t" } } });
    expect((await readProposal(deps())).proposal).toBeNull();
  });
});

describe("approveProposal", () => {
  it("publishes the rules as the administrator, and the rules then decide", async () => {
    const id = await propose();
    const { proposal } = await readProposal(deps());
    expect(await approveProposal(id, proposal!.actionDigest, deps())).toEqual({ ok: true });
    const after = await readProposal(deps());
    expect(after.proposal).toMatchObject({ id, state: "approved", decidedBy: "Admin" });
    const decision = await call(tokens.creator, "POST", "/v1/decisions", { action: { tool_ref: "ext:fernhill-desk:okta_assign_admin_role", arguments: {} }, actor: {}, continuation: { kind: "langgraph", delivery: "pull", correlation: { thread_id: "t" } } });
    expect(decision.body.data.decision).toBe("deny");
  });

  it("a stale digest is a failure result the panel can show, not a throw", async () => {
    const id = await propose();
    const out = await approveProposal(id, "0".repeat(64), deps());
    expect(out).toMatchObject({ ok: false, status: 409 });
  });
});

describe("toProposal fails closed", () => {
  const REF = (t: string) => `ext:fernhill-desk:${t}`;
  const policy = (over: Record<string, unknown> = {}) => ({
    role: "baseline",
    rationale: "why",
    assessment: { side_effect_level: "external" },
    policy: { kind: "tool_invocation", subjects: [{ type: "role", id: "everyone" }], targets: { tools: [REF("slack_invite")] }, config: { mode: "always_allow" }, ...over },
  });
  const tool = (ref: string, over: Record<string, unknown> = {}) => ({ tool_ref: ref, owner_kind: "org", transport: "external", input_schema: { type: "object" }, side_effect_level: "external", show_arguments_to_approvers: true, ...over });
  const raw = (args: unknown, state = "pending") => ({ id: "p", state, tool_ref: "tool:noblecloak:propose-policy-set", action_digest: "d", created_at: "2026-11-03T00:00:00.000Z", arguments: args });
  const of = (policies: unknown[], tools: unknown[] = [tool(REF("slack_invite"))]) => toProposal(raw({ agent: { id: "a", principal_id: "svc_adapter" }, tools, policies }))!;

  it("recognizes the plan the skill builds, all nine", () => {
    const args = argsOf(plan);
    const p = toProposal(raw(args))!;
    expect(p.unrecognized).toEqual([]);
    expect(p.rules).toHaveLength(9);
    expect(p.principal).toBe("svc_adapter");
    expect(isApprovable(p)).toBe(true);
  });

  it("recognizes the plan a fresh session really wrote, with its own assessments, and it stays approvable", () => {
    const p = toProposal(raw(argsOf(freshPlan)))!;
    expect(p.unrecognized).toEqual([]);
    expect(p.rules).toHaveLength(9);
    expect(isApprovable(p)).toBe(true);
    expect(p.rules.find((r) => r.tool === "okta_assign_admin_role")).toMatchObject({ mode: "deny", sideEffect: "admin" });
    expect(p.rules.find((r) => r.tool === "slack_invite")).toMatchObject({ mode: "always_allow", sideEffect: "external" });
  });

  it("recognizes the second fresh session's plan too", () => {
    const p = toProposal(raw(argsOf(freshPlan2)))!;
    expect(p.unrecognized).toEqual([]);
    expect(isApprovable(p)).toBe(true);
  });

  it("does not fix the side effect level or the description: those are Claude's own assessment, and the rule shows them", () => {
    const p = of([{ ...policy(), assessment: { side_effect_level: "write" } }], [tool(REF("slack_invite"), { side_effect_level: "write", description: "Anything Claude wrote" })]);
    expect(isApprovable(p)).toBe(true);
    expect(p.rules[0]).toMatchObject({ sideEffect: "write", description: "Anything Claude wrote", inputSchema: { type: "object" } });
  });

  it("a tool entry with no matching rule blocks", () => {
    const p = of([policy()], [tool(REF("slack_invite")), tool(REF("cdw_order_laptop"))]);
    expect(p.unrecognized.join(" ")).toContain("cdw_order_laptop");
    expect(isApprovable(p)).toBe(false);
  });

  it("a rule with no tool entry stays listed and blocks", () => {
    const p = of([policy()], []);
    expect(p.rules).toHaveLength(1);
    expect(p.unrecognized.join(" ")).toContain("slack_invite");
    expect(isApprovable(p)).toBe(false);
  });

  it("a side effect level outside the contract's enum blocks", () => {
    const p = of([{ ...policy(), assessment: { side_effect_level: "sideways" } }], [tool(REF("slack_invite"), { side_effect_level: "sideways" })]);
    expect(p.unrecognized.join(" ")).toContain("sideways");
    expect(isApprovable(p)).toBe(false);
  });

  it("a missing side effect level blocks", () => {
    const { side_effect_level: _gone, ...entry } = tool(REF("slack_invite"));
    expect(isApprovable(of([policy()], [entry]))).toBe(false);
  });

  it("a tool's level that disagrees with the rule's assessment blocks, showing both", () => {
    const p = of([policy()], [tool(REF("slack_invite"), { side_effect_level: "read" })]);
    expect(p.unrecognized.join(" ")).toContain("read");
    expect(p.unrecognized.join(" ")).toContain("external");
    expect(isApprovable(p)).toBe(false);
  });

  it("a rule with no assessment blocks", () => {
    const { assessment: _gone, ...entry } = policy();
    expect(isApprovable(of([entry]))).toBe(false);
  });

  it("does not require a minimum level for a tool: read on the admin tool is the writer's call, and the panel shows it", () => {
    const admin = policy({ targets: { tools: [REF("okta_assign_admin_role")] } });
    const p = of([{ ...admin, assessment: { side_effect_level: "read" } }], [tool(REF("okta_assign_admin_role"), { side_effect_level: "read" })]);
    expect(isApprovable(p)).toBe(true);
    expect(p.rules[0].sideEffect).toBe("read");
  });

  const BAD_TOOLS: [string, Record<string, unknown>, string][] = [
    ["a key propose.mjs does not accept", { approver_groups: ["x"] }, "approver_groups"],
    ["another transport", { transport: "mcp" }, "mcp"],
    ["another owner", { owner_kind: "platform" }, "platform"],
    ["arguments hidden from approvers", { show_arguments_to_approvers: false }, "show_arguments_to_approvers"],
  ];
  for (const [what, over, shown] of BAD_TOOLS) {
    it(`a tool entry with ${what} is shown raw and blocks approval`, () => {
      const p = of([policy()], [tool(REF("slack_invite"), over)]);
      expect(p.unrecognized.join(" ")).toContain(shown);
      expect(isApprovable(p)).toBe(false);
    });
  }
  it("a tool entry that leaves out show_arguments_to_approvers blocks", () => {
    const { show_arguments_to_approvers: _gone, ...entry } = tool(REF("slack_invite"));
    expect(isApprovable(of([policy()], [entry]))).toBe(false);
  });
  it("a tool listed twice blocks", () => {
    const p = of([policy()], [tool(REF("slack_invite")), tool(REF("slack_invite"))]);
    expect(p.unrecognized.join(" ")).toContain("slack_invite");
    expect(isApprovable(p)).toBe(false);
  });

  const BAD: [string, Record<string, unknown>, string][] = [
    ["a foreign prefix that ends in one of the nine", { targets: { tools: ["ext:other:slack_invite"] } }, "ext:other:slack_invite"],
    ["an mcp ref that ends in one of the nine", { targets: { tools: ["mcp:x:slack_invite"] } }, "mcp:x:slack_invite"],
    ["an unknown tool", { targets: { tools: [REF("delete_everything")] } }, "delete_everything"],
    ["a second target", { targets: { tools: [REF("slack_invite"), REF("okta_assign_admin_role")] } }, "okta_assign_admin_role"],
    ["all tools", { targets: { tools: "all" } }, "all"],
    ["no target", { targets: { tools: [] } }, "targets"],
    ["an unknown mode", { config: { mode: "sometimes" } }, "sometimes"],
    ["escalate, which this page has no group for", { config: { mode: "escalate" } }, "escalate"],
    ["another config member", { config: { mode: "ask", approver_groups: ["x"] } }, "approver_groups"],
    ["a subject other than everyone", { subjects: [{ type: "role", id: "member" }] }, "member"],
    ["a second subject", { subjects: [{ type: "role", id: "everyone" }, { type: "agent", id: "z" }] }, '"z"'],
    ["another policy kind", { kind: "approval_routing" }, "approval_routing"],
  ];
  for (const [what, over, shown] of BAD) {
    it(`${what} is shown raw and blocks approval`, () => {
      const p = of([policy(over)]);
      expect(p.rules).toEqual([]);
      expect(p.unrecognized.join(" ")).toContain(shown);
      expect(isApprovable(p)).toBe(false);
    });
  }

  it("a bad rule among good ones keeps the good ones listed and still blocks", () => {
    const p = of([policy(), policy({ targets: { tools: [REF("delete_everything")] } })]);
    expect(p.rules).toHaveLength(1);
    expect(p.policyCount).toBe(2);
    expect(p.unrecognized).toHaveLength(1);
    expect(isApprovable(p)).toBe(false);
  });

  it("an unknown or foreign tool in arguments.tools blocks, even with no rule on it", () => {
    for (const ref of ["ext:other:slack_invite", REF("delete_everything")]) {
      const p = of([policy()], [tool(REF("slack_invite")), tool(ref)]);
      expect(p.unrecognized.join(" ")).toContain(ref);
      expect(isApprovable(p)).toBe(false);
    }
  });

  it("two rules on one tool block", () => {
    expect(isApprovable(of([policy(), policy({ config: { mode: "deny" } })]))).toBe(false);
  });

  it("a member the proposal should not have blocks", () => {
    const p = toProposal(raw({ agent: { id: "a", principal_id: "svc_adapter" }, tools: [], policies: [policy()], grants: ["everything"] }))!;
    expect(p.unrecognized.join(" ")).toContain("grants");
    expect(isApprovable(p)).toBe(false);
  });

  it("a pending proposal whose arguments cannot be read still shows, and blocks", () => {
    for (const args of [undefined, "junk", { policies: "junk" }, { policies: [] }, { policies: ["junk"] }]) {
      const p = toProposal(raw(args));
      expect(p, JSON.stringify(args)).not.toBeNull();
      expect(p!.unrecognized.length).toBeGreaterThan(0);
      expect(isApprovable(p!)).toBe(false);
    }
  });

  it("a decided proposal, whose arguments are gone, is not a warning", () => {
    const p = toProposal({ ...raw(undefined, "consumed"), resolution_history: [{ resolution: "approved", by: { id: "user_admin", display_name: "Admin" } }] })!;
    expect(p).toMatchObject({ state: "approved", unrecognized: [] });
    expect(isApprovable(p)).toBe(false);
  });

  it("the server refuses to approve what the panel would block, even if the button is bypassed", async () => {
    const agent = await call(tokens.creator_user, "POST", "/v1/agents", { name: "x" }, { "idempotency-key": crypto.randomUUID() });
    const opened = await call(tokens.creator_user, "POST", "/v1/approvals", {
      action: {
        tool_ref: "tool:noblecloak:propose-policy-set",
        arguments: { agent: { id: agent.body.data.id, principal_id: "svc_adapter" }, tools: [tool("ext:other:slack_invite")], policies: [{ role: "baseline", rationale: "r", assessment: { side_effect_level: "external", blast_radius: "one_record", reversible: true, external_party: false, financial: false }, policy: { kind: "tool_invocation", subjects: [{ type: "role", id: "everyone" }], targets: { tools: ["ext:other:slack_invite"] }, config: { mode: "always_allow" } } }] },
      },
      continuation: { kind: "mcp_held", delivery: "held" },
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const read = await call(tokens.admin, "GET", `/v1/approvals/${opened.body.data.id}`);
    const out = await approveProposal(opened.body.data.id, read.body.data.action_digest, deps());
    expect(out).toMatchObject({ ok: false, status: 422 });
    expect((await call(tokens.admin, "GET", `/v1/approvals/${opened.body.data.id}`)).body.data.state).toBe("pending");
  });
});

describe("approveProposal fails closed before it resolves", () => {
  /** A deployment that answers the read as told and records every other request. */
  const stub = (read: () => Response) => {
    const posts: string[] = [];
    return {
      posts,
      deps: {
        baseUrl: BASE,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          if (req.url.endsWith("/__mock/tokens")) return Response.json({ admin: "t" });
          if (req.method === "POST") {
            posts.push(req.url);
            return Response.json({ data: {} });
          }
          return read();
        }) as typeof fetch,
      },
    };
  };
  const good = (over: Record<string, unknown> = {}) => ({ id: "p", state: "pending", tool_ref: "tool:noblecloak:propose-policy-set", action_digest: "d", created_at: "2026-11-03T00:00:00.000Z", arguments: argsOf(freshPlan), ...over });

  it("resolves a recognized, approvable proposal whose digest matches", async () => {
    const s = stub(() => Response.json({ data: good() }));
    expect(await approveProposal("p", "d", s.deps)).toEqual({ ok: true });
    expect(s.posts).toHaveLength(1);
  });
  it("a read that says 404 is a 404, and nothing is resolved", async () => {
    const s = stub(() => Response.json({}, { status: 404 }));
    expect(await approveProposal("p", "d", s.deps)).toMatchObject({ ok: false, status: 404 });
    expect(s.posts).toEqual([]);
  });
  for (const [what, read] of [
    ["a 500", () => Response.json({}, { status: 500 })],
    ["a 403", () => Response.json({}, { status: 403 })],
    ["a 200 with no data", () => Response.json({})],
    ["a 200 that is some other approval", () => Response.json({ data: good({ tool_ref: "ext:fernhill-desk:slack_invite" }) })],
    ["a 200 of the wrong shape", () => Response.json({ data: { id: "p" } })],
  ] as [string, () => Response][]) {
    it(`${what} is a 502, and nothing is resolved`, async () => {
      const s = stub(read);
      expect(await approveProposal("p", "d", s.deps)).toMatchObject({ ok: false, status: 502 });
      expect(s.posts).toEqual([]);
    });
  }
  it("a proposal that changed since the page read it is refused before resolving", async () => {
    const s = stub(() => Response.json({ data: good({ action_digest: "changed" }) }));
    expect(await approveProposal("p", "d", s.deps)).toMatchObject({ ok: false, status: 409 });
    expect(s.posts).toEqual([]);
  });
  it("a pending proposal that is not approvable is refused before resolving", async () => {
    const s = stub(() => Response.json({ data: good({ arguments: { policies: [] } }) }));
    expect(await approveProposal("p", "d", s.deps)).toMatchObject({ ok: false, status: 422 });
    expect(s.posts).toEqual([]);
  });
  it("a proposal already decided is not resolved again", async () => {
    const s = stub(() => Response.json({ data: good({ state: "consumed" }) }));
    expect(await approveProposal("p", "d", s.deps)).toMatchObject({ ok: false, status: 409 });
    expect(s.posts).toEqual([]);
  });
});
