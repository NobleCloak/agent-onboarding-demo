import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadConfig, mockOnlyRefusal } from "./demo-config";
import { deploymentSpecs, portProblems, realSpecs } from "./demo";
import { liveLauncher } from "./demo-state";
import { waitFor } from "./demo-state";
import { runPreflight } from "./preflight";
import { configFor, makeRepo, put, sendJson, serve, tempDir } from "./test-support/fixtures";

const DEPLOYMENT = { NEXT_PUBLIC_FERNHILL_MODE: "deployment" };
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const harness = fileURLToPath(new URL("./test-support/launcher-harness.ts", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const deployed = async (root = makeRepo()) => {
  const base = await configFor(root);
  return { ...loadConfig({ ...DEPLOYMENT, FERNHILL_APP_PORT: String(base.appPort), FERNHILL_MOCK_PORT: String(base.mockPort), HOME: base.home }, root), baseBranch: base.baseBranch };
};

describe("loadConfig mode", () => {
  it("is mock by default: the app at 127.0.0.1 and the mock's credential under .data", () => {
    const cfg = loadConfig({}, "/tmp/r");
    expect(cfg).toMatchObject({ mode: "mock", appUrl: "http://127.0.0.1:3417", credentialFile: "/tmp/r/.data/noblecloak-sp.credentials.json" });
  });
  it("deployment: the app at localhost, and the credential the environment names (none when unset)", () => {
    expect(loadConfig({ ...DEPLOYMENT, NOBLECLOAK_SP_CREDENTIALS: "/secrets/sp.json" }, "/tmp/r")).toMatchObject({ mode: "deployment", appUrl: "http://localhost:3417", credentialFile: "/secrets/sp.json" });
    expect(loadConfig(DEPLOYMENT, "/tmp/r").credentialFile).toBe("");
  });
  it("refuses a mode it does not know", () => expect(() => loadConfig({ NEXT_PUBLIC_FERNHILL_MODE: "prod" }, "/tmp/r")).toThrow(/mock" or "deployment/));
});

describe("the launcher's commands", () => {
  it("deployment: the app on localhost and nothing else when there is no worker; no mock, no mock environment", async () => {
    const cfg = await deployed();
    const specs = realSpecs(cfg);
    expect(specs.map((s) => s.name)).toEqual(["app"]);
    expect(specs[0]!.args).toEqual(["dev", "-p", String(cfg.appPort), "-H", "localhost"]);
    expect(specs[0]!.env).toMatchObject({ NEXT_PUBLIC_FERNHILL_MODE: "deployment", FERNHILL_ALLOWED_ORIGINS: `http://localhost:${cfg.appPort}` });
    expect(JSON.stringify(specs)).not.toMatch(/mock|noblecloak-local|NC_LOCAL/i);
  });
  it("deployment: the worker joins once worker.ts and the named credential file exist", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    const credential = join(tempDir(), "sp.json");
    const base = await deployed(root);
    const cfg = { ...base, credentialFile: credential };
    expect(deploymentSpecs(cfg).map((s) => s.name)).toEqual(["app"]); // no credential yet
    writeFileSync(credential, "{}");
    expect(deploymentSpecs(cfg).map((s) => s.name)).toEqual(["app", "worker"]);
    expect(deploymentSpecs({ ...base, credentialFile: "" }).map((s) => s.name)).toEqual(["app"]); // NOBLECLOAK_SP_CREDENTIALS unset
  });
  it("deployment: the app is ready when /api/health answers, though /api/run is 401 until someone signs in", async () => {
    const cfg = await deployed();
    const server = await serve(cfg.appPort, (q, res) => {
      if (q.url === "/api/health") return sendJson(res, { ok: true, mode: "deployment" });
      return sendJson(res, { ok: false }, 401);
    });
    cleanups.push(server.close);
    const ready = deploymentSpecs(cfg)[0]!.ready;
    expect(ready).toEqual({ http: `${cfg.appUrl}/api/health` });
    const url = (ready as { http: string }).http.replace("localhost", "127.0.0.1");
    expect((await fetch(url)).ok).toBe(true);
    expect((await fetch(url.replace("/api/health", "/api/run"))).ok).toBe(false);
  });
  it("mock mode still starts the mock first, the app on 127.0.0.1", async () => {
    const cfg = await configFor(makeRepo());
    const specs = realSpecs(cfg);
    expect(specs.map((s) => s.name)).toEqual(["mock", "app"]);
    expect(specs[1]!.args).toContain("127.0.0.1");
  });
  it("deployment: a busy mock port is not a problem, a busy app port is", async () => {
    const cfg = await deployed();
    const holder = await serve(cfg.mockPort, (_q, res) => res.end());
    cleanups.push(holder.close);
    expect(await portProblems(cfg)).toEqual([]);
    const app = await serve(cfg.appPort, (_q, res) => res.end());
    cleanups.push(app.close);
    expect((await portProblems(cfg)).join("\n")).toMatch(/\(app\) is already in use/);
    expect(await portProblems({ ...cfg, mode: "mock" })).toHaveLength(2);
  });
  it("deployment: the real launcher starts the app, never a mock, and writes no .env.local", async () => {
    const root = makeRepo();
    const cfg = await deployed(root);
    const child = spawn(process.execPath, ["--import", tsx, harness], {
      cwd: root,
      env: { ...process.env, ...DEPLOYMENT, FERNHILL_APP_PORT: String(cfg.appPort), FERNHILL_MOCK_PORT: String(cfg.mockPort), FAKE_LOG: join(tempDir(), "fake.log") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    cleanups.push(async () => {
      if (child.exitCode === null) {
        child.kill("SIGINT");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
      }
    });
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    expect(Object.keys(liveLauncher(cfg.stateFile)!.children)).toEqual(["app"]);
    expect(existsSync(join(root, ".env.local"))).toBe(false);
    expect(out).toContain("deployment mode: no mock");
    expect(out).not.toMatch(/\[mock\]/);
    child.kill("SIGINT");
    await exited;
  }, 30_000);
});

describe("the mock-only commands in deployment mode", () => {
  it("say so", () => {
    expect(mockOnlyRefusal("mock", "bun run reset")).toBeNull();
    expect(mockOnlyRefusal("deployment", "bun run reset")).toMatch(/bun run reset is mock only/);
  });
  it.each([
    ["scripts/reset-run.ts", "bun run reset"],
    ["scripts/reset-full.ts", "bun run reset:full"],
    ["scripts/demo-new.ts", "bun run demo:new"],
  ])("%s refuses before doing anything (exit 1, nothing changed)", (script, name) => {
    const run = spawnSync(process.execPath, ["--import", tsx, join(process.cwd(), script)], { cwd: process.cwd(), env: { ...process.env, ...DEPLOYMENT }, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`REFUSED: ${name} is mock only`);
    expect(run.stdout).toBe("");
  });
  it("an unknown mode is refused the same way, not read as mock", () => {
    const run = spawnSync(process.execPath, ["--import", tsx, join(process.cwd(), "scripts/reset-run.ts")], { cwd: process.cwd(), env: { ...process.env, NEXT_PUBLIC_FERNHILL_MODE: "prod" }, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("REFUSED:");
  });
  it("in mock mode the same entry point gets as far as its own checks", () => {
    const run = spawnSync(process.execPath, ["--import", tsx, join(process.cwd(), "scripts/reset-run.ts")], { cwd: tempDir(), env: { ...process.env, NEXT_PUBLIC_FERNHILL_MODE: "mock" }, encoding: "utf8" });
    expect(run.stderr).not.toContain("is mock only");
    expect(run.stderr).toMatch(/REFUSED: Run this from/);
  });
});

describe("deployment preflight", () => {
  const good = (credential: string) => ({
    NC_BASE_URL: "https://govern.noblecloak.com",
    NEXT_PUBLIC_NC_API_URL: "https://govern.noblecloak.com",
    NEXT_PUBLIC_NC_ISSUER: "https://auth.noblecloak.com",
    NEXT_PUBLIC_NC_CLIENT_ID: "bnoauth_abc",
    NEXT_PUBLIC_NC_REDIRECT_URI: "http://localhost:3417/auth/callback",
    NOBLECLOAK_SP_CREDENTIALS: credential,
    NC_EXPECTED_PRINCIPAL: "sp_123",
  });
  const setup = async (over: Record<string, string | undefined> = {}, credential: Record<string, unknown> | string | null = { client_id: "sp_123", token_endpoint: "https://auth.noblecloak.com/oauth/token" }) => {
    const root = makeRepo();
    const base = await deployed(root);
    const file = join(tempDir(), "sp.json");
    if (credential !== null) writeFileSync(file, typeof credential === "string" ? credential : JSON.stringify(credential));
    const env = { ...good(file), ...over };
    const cfg = { ...base, port: 3417, appUrl: "http://localhost:3417", credentialFile: env.NOBLECLOAK_SP_CREDENTIALS ? file : "" };
    return { cfg, env, root, file };
  };
  const failed = (r: { checks: { name: string; status: string }[] }) => r.checks.filter((c) => c.status === "fail").map((c) => c.name);

  it("passes with everything set, and makes no network call", async () => {
    const { cfg, env } = await setup();
    const fetch = (() => { throw new Error("network call"); }) as unknown as typeof globalThis.fetch;
    const report = await runPreflight(cfg, { env, fetch });
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(["mode", "api", "sign-in", "credentials", "principal", "install"]);
    expect(report.checks.map((c) => c.detail).join("\n")).not.toMatch(/mock at|127\.0\.0\.1/);
  });
  it("never prints the credential file's contents", async () => {
    const { cfg, env } = await setup({}, { client_id: "sp_123", client_secret: "SHHH-SECRET", token_endpoint: "https://auth.noblecloak.com/oauth/token" });
    expect(JSON.stringify(await runPreflight(cfg, { env }))).not.toContain("SHHH");
  });
  it.each([
    ["NC_BASE_URL unset", { NC_BASE_URL: undefined }, "api"],
    ["NC_BASE_URL is the mock", { NC_BASE_URL: "http://127.0.0.1:8787" }, "api"],
    ["NC_BASE_URL differs from the sign-in audience", { NC_BASE_URL: "https://other.example.com" }, "api"],
    ["client id left as REPLACE_ME", { NEXT_PUBLIC_NC_CLIENT_ID: "REPLACE_ME" }, "sign-in"],
    ["redirect URI on another origin", { NEXT_PUBLIC_NC_REDIRECT_URI: "http://localhost:3999/auth/callback" }, "sign-in"],
    ["credential path unset", { NOBLECLOAK_SP_CREDENTIALS: undefined }, "credentials"],
    ["principal unset", { NC_EXPECTED_PRINCIPAL: undefined }, "principal"],
    ["principal is the mock's", { NC_EXPECTED_PRINCIPAL: "svc_adapter" }, "principal"],
  ])("fails when %s", async (_name, over, check) => {
    const { cfg, env } = await setup(over);
    expect(failed(await runPreflight(cfg, { env }))).toEqual([check]);
  });
  it("fails when the credential file is missing, unreadable as JSON, has no client_id, or is the mock's", async () => {
    for (const credential of [null, "not json", {}, { client_id: "svc_adapter", token_endpoint: "http://127.0.0.1:8787/oauth/token" }] as const) {
      const { cfg, env } = await setup({}, credential);
      expect(failed(await runPreflight(cfg, { env })), JSON.stringify(credential)).toEqual(["credentials"]);
    }
  });
  it("fails when the credential file is inside the repo", async () => {
    const { cfg, env, root } = await setup();
    const inside = join(root, "sp.json");
    writeFileSync(inside, JSON.stringify({ client_id: "sp_123" }));
    expect(failed(await runPreflight({ ...cfg, credentialFile: inside }, { env: { ...env, NOBLECLOAK_SP_CREDENTIALS: inside } }))).toEqual(["credentials"]);
  });
  it("warns, without failing, when the install has not been done", async () => {
    const { cfg, env } = await setup();
    const report = await runPreflight(cfg, { env });
    expect(report.checks.find((c) => c.name === "install")).toMatchObject({ status: "warn" });
  });
  it("mock mode is untouched: it still looks for the mock", async () => {
    const cfg = await configFor(makeRepo());
    const report = await runPreflight(cfg, { fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect(report.checks[0]).toMatchObject({ name: "mock", status: "fail" });
  });
});
