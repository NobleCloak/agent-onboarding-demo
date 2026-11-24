import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CREDENTIAL_PATH, RULES_PLAN, type DemoConfig } from "./demo-config";
import { writeState } from "./demo-state";
import { runPreflight, type Report } from "./preflight";
import { configFor, liveState, makeRepo, put, sendJson, serve, type Handler } from "./test-support/fixtures";

const PREFIX = "ext:fernhill-desk:";
const PLAN = {
  agent: { principal_id: "svc_adapter" },
  tools: ["a", "b", "c"].map((n) => ({ tool_ref: PREFIX + n })),
  policies: [
    { role: "baseline", tool: PREFIX + "a", mode: "always_allow" },
    { role: "baseline", tool: PREFIX + "b", mode: "ask" },
    { role: "baseline", tool: PREFIX + "c", mode: "deny" },
  ],
};

type World = { approvals: unknown[]; tools: string[]; policies: Array<{ tool: string; mode: string; state?: string; subject?: string }>; run: { state: string }; audience?: string; mockUp: boolean; appUp: boolean };
const goodWorld = (): World => ({
  approvals: [],
  tools: PLAN.tools.map((t) => t.tool_ref),
  policies: PLAN.policies.map((p) => ({ tool: p.tool, mode: p.mode })),
  run: { state: "idle" },
  mockUp: true,
  appUp: true,
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type Setup = { installed: boolean; world?: Partial<World>; credentials?: boolean; envLocal?: "good" | "wrong" | "missing"; worker?: "ok" | "dead" | "reused" | "none" | "no-launcher" };

async function setup(options: Setup): Promise<{ cfg: DemoConfig; world: World; root: string }> {
  const root = makeRepo();
  const cfg = await configFor(root);
  const world = { ...goodWorld(), ...options.world };
  put(root, RULES_PLAN, JSON.stringify(PLAN));
  put(root, "package.json", JSON.stringify({ name: "x" }));
  put(root, "node_modules/@noblecloak/langgraph/package.json", JSON.stringify({ version: "0.5.2", dependencies: { "@noblecloak/client": ">=0.13.1 <0.15.0" } }));
  put(root, "node_modules/@noblecloak/client/package.json", JSON.stringify({ version: "0.14.1" }));
  if (options.installed) put(root, "src/noblecloak/worker.ts", "export {};\n");
  if (options.credentials !== false) put(root, CREDENTIAL_PATH, JSON.stringify({ client_id: "sp_1", token_endpoint: `${cfg.mockUrl}/oauth/token` }));
  const env = options.envLocal ?? "good";
  if (env !== "missing") {
    put(root, ".env.local", `NC_BASE_URL=${env === "good" ? cfg.mockUrl : "http://127.0.0.1:1"}\nNOBLECLOAK_SP_CREDENTIALS=${CREDENTIAL_PATH}\nNC_EXPECTED_PRINCIPAL=svc_adapter\n`);
  }
  if (options.installed && options.worker !== "no-launcher") {
    const live = await liveState(cfg, { worker: options.worker ?? "ok" });
    closers.push(async () => live.stop());
    writeState(cfg.stateFile, live.state);
  }
  const mock: Handler = (req, res) => {
    const url = new URL(req.url ?? "/", cfg.mockUrl);
    if (url.pathname === "/__mock/tokens") return sendJson(res, { audience: world.audience ?? cfg.mockUrl, admin: "tok-admin", creator: "tok-creator" });
    if (req.headers.authorization !== "Bearer tok-admin") return sendJson(res, { error: "unauthorized" }, 401);
    if (url.pathname === "/v1/approvals") return sendJson(res, { data: world.approvals, meta: { next: null } });
    if (url.pathname === "/v1/tools") return sendJson(res, { data: [{ tool_ref: "mcp:tracker:search", status: "active" }, ...world.tools.map((tool_ref) => ({ tool_ref, status: "active" }))], meta: { next: null } });
    if (url.pathname === "/v1/policies") {
      return sendJson(res, {
        data: world.policies.map((p, i) => ({ id: `pol_${i}`, kind: "tool_invocation", state: p.state ?? "published", published_at: "2026-01-01", subjects: [{ type: "role", id: p.subject ?? "everyone" }], targets: { tools: [p.tool] }, config: { mode: p.mode } })),
        meta: { next: null },
      });
    }
    return sendJson(res, { error: "not_found" }, 404);
  };
  const app: Handler = (req, res) => (req.url === "/api/run" ? sendJson(res, world.run) : sendJson(res, {}, 404));
  if (world.mockUp) closers.push((await serve(cfg.mockPort, mock)).close);
  if (world.appUp) closers.push((await serve(cfg.appPort, app)).close);
  return { cfg, world, root };
}

const failed = (r: Report) => r.checks.filter((c) => c.status === "fail").map((c) => c.name);
const find = (r: Report, name: string) => r.checks.find((c) => c.name === name)!;

describe("preflight", () => {
  it("passes on an installed tree whose nine tools (here three) match the plan", async () => {
    const { cfg } = await setup({ installed: true });
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("passes on a pre-install tree with no worker and no rules", async () => {
    const { cfg } = await setup({ installed: false, world: { tools: [], policies: [] } });
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual([]);
    expect(find(report, "worker").detail).toMatch(/not installed/i);
  });

  it("fails and names the item when a pending approval exists", async () => {
    const { cfg } = await setup({ installed: true, world: { approvals: [{ id: "apr_1", state: "pending", tool_ref: PREFIX + "b" }] } });
    const report = await runPreflight(cfg);
    expect(report.ok).toBe(false);
    expect(failed(report)).toEqual(["approvals"]);
    expect(find(report, "approvals").detail).toContain("apr_1");
  });

  it("fails and names the tool when a rule differs from the plan", async () => {
    const { cfg } = await setup({ installed: true, world: { policies: PLAN.policies.map((p) => ({ tool: p.tool, mode: p.tool.endsWith(":b") ? "always_allow" : p.mode })) } });
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual(["rules"]);
    expect(find(report, "rules").detail).toMatch(/b.*expected ask.*always_allow/s);
  });

  it("fails when a tool from the plan is not registered", async () => {
    const { cfg } = await setup({ installed: true, world: { tools: [PREFIX + "a", PREFIX + "b"] } });
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual(["rules"]);
    expect(find(report, "rules").detail).toContain("c");
  });

  it("fails when the worker is down on an installed tree", async () => {
    const { cfg } = await setup({ installed: true, worker: "dead" });
    expect(failed(await runPreflight(cfg))).toEqual(["worker"]);
  });

  it("fails, naming the case where the worker has not appeared yet, when the launcher is running without one", async () => {
    const { cfg } = await setup({ installed: true, worker: "none" });
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual(["worker"]);
    expect(find(report, "worker").detail).toMatch(/not started the worker yet/);
    expect(find(report, "worker").detail).toMatch(/\[worker\] lines/);
  });

  it("fails with the launcher's own note when it gave up on the worker", async () => {
    const { cfg } = await setup({ installed: true, worker: "none" });
    const live = await liveState(cfg, { worker: "none" });
    closers.push(async () => live.stop());
    writeState(cfg.stateFile, { ...live.state, workerNote: "gave up after 3 quick exits; will retry when worker.ts changes" });
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual(["worker"]);
    expect(find(report, "worker").detail).toContain("gave up after 3 quick exits");
  });

  it("fails when the recorded worker pid is alive but is not running worker.ts (a reused pid)", async () => {
    const { cfg } = await setup({ installed: true, worker: "reused" });
    expect(failed(await runPreflight(cfg))).toEqual(["worker"]);
  });

  it("fails, saying to restart through bun run demo, when no launcher is running; a worker found anyway is named", async () => {
    const { cfg } = await setup({ installed: true, worker: "no-launcher" });
    const none = await runPreflight(cfg, { findWorkers: () => [] });
    expect(failed(none)).toEqual(["worker"]);
    expect(find(none, "worker").detail).toMatch(/bun run demo/);
    const stranger = await runPreflight(cfg, { findWorkers: () => [{ pid: 4242, startedAt: null }] });
    expect(failed(stranger)).toEqual(["worker"]);
    expect(find(stranger, "worker").detail).toMatch(/4242.*did not start it/);
  });

  it("fails when the worker started before the mock (it holds a dead token)", async () => {
    const { cfg } = await setup({ installed: true });
    const early = await liveState(cfg, { worker: "ok", workerBeforeMock: true });
    closers.push(async () => early.stop());
    writeState(cfg.stateFile, early.state);
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual(["worker"]);
    expect(find(report, "worker").detail).toMatch(/before the mock/);
  });

  it("fails when rules exist on a pre-install tree", async () => {
    const { cfg } = await setup({ installed: false });
    const report = await runPreflight(cfg);
    expect(failed(report)).toEqual(["rules"]);
    expect(find(report, "rules").detail).toMatch(/pre-install/);
  });

  it("fails when a run is finished or parked", async () => {
    for (const state of ["finished", "parked"]) {
      const { cfg } = await setup({ installed: true, world: { run: { state } } });
      expect(failed(await runPreflight(cfg))).toEqual(["run"]);
      while (closers.length) await closers.pop()!();
    }
  });

  it("fails naming the mock when it is not reachable, and the app when it is not", async () => {
    const { cfg } = await setup({ installed: true, world: { mockUp: false, appUp: false } });
    const names = failed(await runPreflight(cfg));
    expect(names).toContain("mock");
    expect(names).toContain("app");
  });

  it("fails naming the mock when what answers is not the local mock for this port", async () => {
    const { cfg } = await setup({ installed: true, world: { audience: "https://govern.example.test" } });
    expect(failed(await runPreflight(cfg))).toContain("mock");
  });

  it("fails when the credential file is missing or points at another mock", async () => {
    const { cfg } = await setup({ installed: true, credentials: false });
    expect(failed(await runPreflight(cfg))).toEqual(["credentials"]);
    while (closers.length) await closers.pop()!();
    const second = await setup({ installed: true });
    writeFileSync(join(second.root, CREDENTIAL_PATH), JSON.stringify({ client_id: "sp_1", token_endpoint: "http://127.0.0.1:1/oauth/token" }));
    expect(failed(await runPreflight(second.cfg))).toEqual(["credentials"]);
  });

  it("fails when .env.local is missing or has the wrong mock address", async () => {
    for (const envLocal of ["missing", "wrong"] as const) {
      const { cfg } = await setup({ installed: true, envLocal });
      expect(failed(await runPreflight(cfg))).toEqual([".env.local"]);
      while (closers.length) await closers.pop()!();
    }
  });

  it("warns, without failing, when the checkout sits under ~/bianoble or the plugin is not installed", async () => {
    const { cfg } = await setup({ installed: false, world: { tools: [], policies: [] } });
    mkdirSync(join(cfg.home, ".claude/plugins"), { recursive: true });
    writeFileSync(join(cfg.home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "other@x": [{}] } }));
    const report = await runPreflight({ ...cfg, root: cfg.root, home: cfg.home }, { pathUnderBianoble: () => true });
    expect(report.ok).toBe(true);
    expect(find(report, "location").status).toBe("warn");
    expect(find(report, "plugin").status).toBe("warn");
  });

  it("passes when the installed client satisfies the range langgraph declares, and fails when it does not", async () => {
    const { cfg, root } = await setup({ installed: false, world: { tools: [], policies: [] } });
    expect(find(await runPreflight(cfg), "client pin").status).toBe("pass");
    for (const ok of ["0.13.1", "0.14.99"]) {
      put(root, "node_modules/@noblecloak/client/package.json", JSON.stringify({ version: ok }));
      expect(find(await runPreflight(cfg), "client pin").status).toBe("pass");
    }
    for (const bad of ["0.13.0", "0.15.0"]) {
      put(root, "node_modules/@noblecloak/client/package.json", JSON.stringify({ version: bad }));
      const report = await runPreflight(cfg);
      expect(find(report, "client pin").status).toBe("fail");
      expect(failed(report)).toEqual(["client pin"]);
    }
  });

  it("still matches an exact declaration (langgraph 0.5.1 and older)", async () => {
    const { cfg, root } = await setup({ installed: false, world: { tools: [], policies: [] } });
    put(root, "node_modules/@noblecloak/langgraph/package.json", JSON.stringify({ version: "0.5.1", dependencies: { "@noblecloak/client": "0.13.1" } }));
    expect(find(await runPreflight(cfg), "client pin").status).toBe("fail"); // 0.14.1 installed, 0.13.1 asked
    put(root, "node_modules/@noblecloak/client/package.json", JSON.stringify({ version: "0.13.1" }));
    expect(find(await runPreflight(cfg), "client pin").status).toBe("pass");
  });

  it("warns about a leftover @noblecloak/client override, which langgraph 0.5.2 no longer needs", async () => {
    const { cfg, root } = await setup({ installed: false, world: { tools: [], policies: [] } });
    put(root, "package.json", JSON.stringify({ name: "x", overrides: { "@noblecloak/client": "0.14.1" } }));
    const check = find(await runPreflight(cfg), "client pin");
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/override/);
  });
});
