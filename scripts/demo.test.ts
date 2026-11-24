import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isAlive, liveLauncher, readState, waitFor, writeState } from "./demo-state";
import { workerReady } from "./demo";
import { resetFull } from "./reset-full";
import { findPluginDir, resetRunCommand } from "./reset-run";
import { configFor, git, makeRepo, put, sendJson, serve, standIn, tempDir } from "./test-support/fixtures";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const harness = fileURLToPath(new URL("./test-support/launcher-harness.ts", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function launch(root: string, cfg: { appPort: number; mockPort: number }, log: string, fast = false) {
  const child = spawn(process.execPath, ["--import", tsx, harness], {
    cwd: root,
    env: { ...process.env, FERNHILL_APP_PORT: String(cfg.appPort), FERNHILL_MOCK_PORT: String(cfg.mockPort), FAKE_LOG: log, ...(fast ? { FAKE_FAST: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  // SIGINT lets the launcher stop its own children; killing it outright would orphan them.
  cleanups.push(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGINT");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return { child, output: () => out, exited };
}

const starts = (log: string, kind: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith(`${kind} `)).map((l) => Number(l.split(" ")[1])) : []);

describe("liveLauncher", () => {
  it("accepts only the recorded process: same script path as `ps` spells it, and the recorded start time", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    // `ps` shows "bun scripts/demo.ts" for the real launcher while the recorded script is absolute: stand in with that shape.
    const proc = await standIn("scripts/demo.ts");
    cleanups.push(proc.stop);
    const state = { pid: proc.pid, root, script: join(root, "scripts/demo.ts"), procStartMs: proc.startMs, startedAt: "", appPort: cfg.appPort, mockPort: cfg.mockPort, mode: "running" as const, generation: 1, children: {} };
    writeState(cfg.stateFile, state);
    expect(liveLauncher(cfg.stateFile)?.pid).toBe(proc.pid);
    // another checkout's script of the same name
    writeState(cfg.stateFile, { ...state, script: join(tempDir(), "scripts/demo.ts") });
    expect(liveLauncher(cfg.stateFile)).toBeNull();
    // a reused pid: right command line, wrong start time
    writeState(cfg.stateFile, { ...state, procStartMs: proc.startMs - 60_000 });
    expect(liveLauncher(cfg.stateFile)).toBeNull();
    // a state file that is not in its own checkout
    const other = tempDir(); // consistent with itself, but not the checkout this state file sits in
    writeState(cfg.stateFile, { ...state, root: other, script: join(other, "scripts/demo.ts") });
    expect(liveLauncher(cfg.stateFile)).toBeNull();
  });
});

describe("worker watch", { timeout: 40_000 }, () => {
  const running = (cfg: { stateFile: string }) => waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
  const workerFile = (root: string, text = "export {};\n") => put(root, "src/noblecloak/worker.ts", text);

  it("starts the worker by itself once worker.ts appears in the running tree, logs it, and touches neither the mock nor the app", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log, true);
    await running(cfg);
    expect(starts(log, "worker")).toHaveLength(0);

    workerFile(root);
    await waitFor("worker started", () => starts(log, "worker").length === 1, 10_000);
    await waitFor("recorded", () => liveLauncher(cfg.stateFile)?.children.worker, 10_000);
    expect(l.output()).toMatch(/\[demo\] .*worker\.ts.* starting the worker/);
    expect(l.output()).toContain("[worker] worker_ready");
    expect(starts(log, "mock")).toHaveLength(1);
    expect(starts(log, "app")).toHaveLength(1);

    l.child.kill("SIGINT"); // the launcher's exit stops the worker too
    await l.exited;
    expect(isAlive(starts(log, "worker")[0]!)).toBe(false);
  });

  it("tolerates a half-written worker.ts: restarts it a few times, gives up at the limit, and starts it once the file is whole", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log, true);
    await running(cfg);

    workerFile(root, "PARTIAL");
    await waitFor("three attempts", () => starts(log, "worker").length === 3, 15_000);
    await waitFor("gave up", () => liveLauncher(cfg.stateFile)?.workerNote, 10_000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(starts(log, "worker")).toHaveLength(3); // the limit holds while the file is unchanged
    expect(liveLauncher(cfg.stateFile)?.mode).toBe("running");
    expect(liveLauncher(cfg.stateFile)?.workerNote).toMatch(/gave up after 3/);

    await new Promise((r) => setTimeout(r, 1100)); // make the mtime differ on coarse filesystems
    workerFile(root, "export {};\n// whole\n");
    await waitFor("fourth start", () => starts(log, "worker").length === 4, 10_000);
    await waitFor("stays up", () => liveLauncher(cfg.stateFile)?.children.worker && !liveLauncher(cfg.stateFile)?.workerNote, 10_000);
    expect(isAlive(starts(log, "worker")[3]!)).toBe(true);
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("a restart asked for while the watcher is starting the worker still happens (the backup path: checkout, then reset)", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    process.env.FAKE_WORKER_DELAY_MS = "1000";
    cleanups.push(() => void delete process.env.FAKE_WORKER_DELAY_MS);
    const l = await launch(root, cfg, log, true);
    await running(cfg);
    const generation = liveLauncher(cfg.stateFile)!.generation;

    workerFile(root);
    await waitFor("the watcher starting the worker", () => starts(log, "worker").length === 1, 10_000);
    l.child.kill("SIGUSR1"); // the worker has not said it is ready, so the launcher is still busy with it

    await waitFor("the restart", () => (liveLauncher(cfg.stateFile)?.generation ?? 0) > generation && liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    expect(starts(log, "mock")).toHaveLength(2);
    expect(starts(log, "worker")).toHaveLength(2);
  });

  it("stops the worker when worker.ts disappears, and restarts one that dies later", async () => {
    const root = makeRepo();
    workerFile(root);
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log, true);
    await running(cfg);
    await waitFor("worker up", () => liveLauncher(cfg.stateFile)?.children.worker, 10_000);
    await new Promise((r) => setTimeout(r, 1800)); // past the early-exit window
    process.kill(starts(log, "worker")[0]!, "SIGKILL");
    await waitFor("restarted after a late death", () => starts(log, "worker").length === 2, 10_000);
    await waitFor("recorded", () => liveLauncher(cfg.stateFile)?.children.worker?.pid === starts(log, "worker")[1], 10_000);

    rmSync(join(root, "src/noblecloak"), { recursive: true });
    await waitFor("worker stopped", () => !isAlive(starts(log, "worker")[1]!), 10_000);
    expect(liveLauncher(cfg.stateFile)?.children.worker).toBeUndefined();
    expect(l.output()).toMatch(/worker\.ts is gone/);
    expect(liveLauncher(cfg.stateFile)?.mode).toBe("running");
    l.child.kill("SIGINT");
    await l.exited;
  });
});

describe("workerReady", () => {
  const ready = async (setup: (root: string) => void) => {
    const root = makeRepo();
    const cfg = await configFor(root);
    setup(root);
    return workerReady(cfg);
  };
  const whole = (root: string) => {
    put(root, "src/noblecloak/worker.ts", "import { a } from './governance.js';\nimport { b } from './log.js';\n");
    put(root, "src/noblecloak/governance.ts", "export const a = 1;\n");
    put(root, "src/noblecloak/log.ts", "export const b = 1;\n");
    put(root, ".data/noblecloak-sp.credentials.json", "{}");
  };

  it("is true only when worker.ts is non-empty, the files it imports exist, and the credential is there", async () => {
    expect(await ready(whole)).toBe(true);
    expect(await ready(() => undefined)).toBe(false);
    expect(await ready((r) => { whole(r); put(r, "src/noblecloak/worker.ts", ""); })).toBe(false);
    expect(await ready((r) => { whole(r); rmSync(join(r, "src/noblecloak/log.ts")); })).toBe(false);
    expect(await ready((r) => { whole(r); rmSync(join(r, ".data"), { recursive: true }); })).toBe(false);
  });
});

describe("findPluginDir", () => {
  const plugin = (home: string, rel: string, withPropose = true) => {
    const dir = join(home, rel);
    if (withPropose) put(dir, "setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs", "// ok\n");
    else mkdirSync(dir, { recursive: true });
    return dir;
  };
  const listing = (home: string, plugins: Record<string, string[]>) =>
    put(home, ".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(plugins).map(([k, paths]) => [k, paths.map((installPath) => ({ scope: "user", installPath }))])) }));

  it("finds the marketplace install of noblecloak from Claude Code's own plugin list", () => {
    const home = tempDir();
    const dir = plugin(home, ".claude/plugins/cache/noblecloak/noblecloak/1.2.3");
    listing(home, { "noblecloak@noblecloak": [dir], "stripe@claude-plugins-official": [plugin(home, "other")] });
    expect(findPluginDir(home)).toBe(dir);
  });

  it("returns nothing when the list is missing, unreadable, has no noblecloak plugin, or the install lacks the setup skill", () => {
    const none = tempDir();
    expect(findPluginDir(none)).toBeUndefined();
    const broken = tempDir();
    put(broken, ".claude/plugins/installed_plugins.json", "{not json");
    expect(findPluginDir(broken)).toBeUndefined();
    const other = tempDir();
    listing(other, { "stripe@claude-plugins-official": [plugin(other, "s")] });
    expect(findPluginDir(other)).toBeUndefined();
    const hollow = tempDir();
    listing(hollow, { "noblecloak@noblecloak": [plugin(hollow, "h", false)] });
    expect(findPluginDir(hollow)).toBeUndefined();
  });
});

describe("demo launcher", { timeout: 30_000 }, () => {
  it("starts the mock and the app, prefixes their output, and Ctrl-C stops both", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log);
    await waitFor("the launcher to be running", () => liveLauncher(join(root, ".demo-launcher.json"))?.mode === "running", 15_000);
    expect(l.output()).toContain("[mock] mock listening");
    expect(l.output()).toContain("[app] app listening");
    expect(l.output()).not.toContain("[worker]");
    const pids = [...starts(log, "mock"), ...starts(log, "app")];
    expect(pids).toHaveLength(2);

    l.child.kill("SIGINT");
    expect(await l.exited).toBe(0);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
    expect(readState(join(root, ".demo-launcher.json"))).toBeNull();
  });

  it("starts the worker only when NobleCloak is installed", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    const cfg = await configFor(root);
    const l = await launch(root, cfg, join(tempDir(), "fake.log"));
    await waitFor("running", () => liveLauncher(join(root, ".demo-launcher.json"))?.mode === "running", 15_000);
    expect(l.output()).toContain("[worker] worker_ready");
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("refuses to start when a port is taken, starts nothing, and leaves the process on that port alone", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const stranger = await serve(cfg.mockPort, (_req, res) => sendJson(res, { stranger: true }));
    cleanups.push(stranger.close);

    const l = await launch(root, cfg, log);
    expect(await l.exited).toBe(1);
    expect(l.output()).toContain(`port ${cfg.mockPort}`);
    expect(l.output()).toContain("did not touch that process");
    expect(starts(log, "mock")).toHaveLength(0);
    expect(starts(log, "app")).toHaveLength(0);
    // The stranger still answers.
    expect(await (await fetch(`${cfg.mockUrl}/anything`)).json()).toEqual({ stranger: true });
  });

  it("refuses a second launcher in the same checkout", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    const first = await launch(root, cfg, join(tempDir(), "fake.log"));
    await waitFor("running", () => liveLauncher(join(root, ".demo-launcher.json"))?.mode === "running", 15_000);
    const second = await launch(root, { appPort: cfg.appPort + 1, mockPort: cfg.mockPort + 1 }, join(tempDir(), "fake2.log"));
    expect(await second.exited).toBe(1);
    expect(second.output()).toContain("already running");
    first.child.kill("SIGINT");
    await first.exited;
  });

  it("reset restarts the mock and the worker (new pids) when the launcher owns them, and not the app", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    put(root, "src/noblecloak/agent.json", '{"name":"x","id":"agt_old"}\n');
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    const before = { mock: starts(log, "mock"), app: starts(log, "app"), worker: starts(log, "worker") };

    const lines: string[] = [];
    const out = await resetRunCommand(cfg, { log: (m) => lines.push(m) });

    expect(out).toEqual({ ok: true, restarted: true, clearedVia: "app" });
    expect(starts(log, "mock")).toHaveLength(2);
    expect(starts(log, "worker")).toHaveLength(2);
    expect(starts(log, "app")).toEqual(before.app);
    expect(isAlive(before.mock[0]!)).toBe(false);
    expect(isAlive(before.worker[0]!)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "src/noblecloak/agent.json"), "utf8")).id).toBeNull();
    expect(lines.join("\n")).toMatch(/rules.*wiped/i);
    expect(lines.join("\n")).not.toMatch(/not installed|no rules to lose/); // this tree has worker.ts: it is installed
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("reset with rules reopens the plan with propose.mjs (fresh mock, person's token) and approves the proposal it reads back", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    put(root, "src/noblecloak/agent.json", '{"name":"x","id":"agt_old"}\n');
    const cfg = await configFor(root);
    const dir = tempDir();
    const log = join(dir, "fake.log");
    // A stand-in for the plugin's propose.mjs: records what it was given and what agent.json held when it ran.
    put(dir, "plugin/setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs", `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "propose " + process.argv.slice(2).join(" ") + " base=" + process.env.NC_BASE_URL + " token=" + process.env.NC_PROPOSER_TOKEN + " agentId=" + JSON.parse(readFileSync("src/noblecloak/agent.json", "utf8")).id + "\\n");`);
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);

    const lines: string[] = [];
    const out = await resetRunCommand(cfg, { log: (m) => lines.push(m) }, { rules: true, pluginDir: join(dir, "plugin") });

    expect(out).toEqual({ ok: true, restarted: true, clearedVia: "app", rules: "approved" });
    const written = readFileSync(log, "utf8");
    expect(written).toContain(`propose --plan demo/rules.plan.json base=${cfg.mockUrl} token=creator-token agentId=null`);
    expect(written).toContain("approve digest-1");
    expect(lines.join("\n")).not.toMatch(/Until they are approved again/);
    expect(lines.join("\n")).not.toMatch(/not installed|no rules to lose/); // an installed tree whose rules were just approved
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("reset with rules says so, and fails, when the plugin directory is not given", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    const cfg = await configFor(root);
    const l = await launch(root, cfg, join(tempDir(), "fake.log"));
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    const lines: string[] = [];
    const out = await resetRunCommand(cfg, { log: (m) => lines.push(m) }, { rules: true });
    expect(out.ok).toBe(false);
    expect(out.rules).toBe("failed");
    expect(lines.join("\n")).toMatch(/RULES NOT RESTORED.*NOBLECLOAK_PLUGIN_DIR/s);
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("reset does not touch any process when the launcher is not running, and says what to restart", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    mkdirSync(cfg.dataDir);
    writeFileSync(join(cfg.dataDir, "run.sqlite"), "x");
    writeFileSync(join(cfg.dataDir, "noblecloak-sp.credentials.json"), "{}");
    const stranger = await serve(cfg.mockPort, (_req, res) => sendJson(res, { stranger: true }));
    cleanups.push(stranger.close);

    const lines: string[] = [];
    const out = await resetRunCommand(cfg, { log: (m) => lines.push(m) });

    expect(out).toEqual({ ok: true, restarted: false, clearedVia: "files" });
    expect(existsSync(join(cfg.dataDir, "run.sqlite"))).toBe(false);
    expect(existsSync(join(cfg.dataDir, "noblecloak-sp.credentials.json"))).toBe(true); // only the run and checkpoints
    expect(lines.join("\n")).toMatch(/NOT restarted/);
    expect(lines.join("\n")).toMatch(/bun run noblecloak/);
    expect(await (await fetch(`${cfg.mockUrl}/x`)).json()).toEqual({ stranger: true });
  });
  it("reset:full pauses the launcher's processes, resets the tree, and starts the mock and app again without a worker", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    expect(starts(log, "worker")).toHaveLength(1);
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(join(cfg.dataDir, "run.sqlite"), "x");

    const lines: string[] = [];
    const out = await resetFull(cfg, { log: (m) => lines.push(m) });

    expect(out.ok).toBe(true);
    expect(git(root, "branch", "--show-current").trim()).toBe("base-branch");
    expect(existsSync(join(root, "src/noblecloak"))).toBe(false);
    expect(existsSync(join(cfg.dataDir, "run.sqlite"))).toBe(false);
    expect(starts(log, "mock")).toHaveLength(2);
    expect(starts(log, "app")).toHaveLength(2);
    expect(starts(log, "worker")).toHaveLength(1); // not started again: the tree no longer has a worker
    expect(isAlive(starts(log, "worker")[0]!)).toBe(false);
    expect(liveLauncher(cfg.stateFile)?.mode).toBe("running");
    expect(liveLauncher(cfg.stateFile)?.children.worker).toBeUndefined();
    expect(lines.join("\n")).toMatch(/restarted/);
    l.child.kill("SIGINT");
    await l.exited;
  });
  it("reset:full that refuses (base branch in another worktree) leaves the running demo untouched: not paused, no restart", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    git(root, "worktree", "add", join(tempDir(), "wt"), "base-branch");
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    const generation = liveLauncher(cfg.stateFile)!.generation;

    const out = await resetFull(cfg, { log: () => undefined });

    expect(out.ok).toBe(false);
    expect(liveLauncher(cfg.stateFile)).toMatchObject({ mode: "running", generation });
    expect(starts(log, "mock")).toHaveLength(1);
    expect(existsSync(join(root, "src/noblecloak/worker.ts"))).toBe(true);
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("reset:full that fails after pausing resumes the demo", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    const cfg = await configFor(root);
    const log = join(tempDir(), "fake.log");
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    writeFileSync(join(root, ".git/index.lock"), "");

    const out = await resetFull(cfg, { log: () => undefined });

    expect(out.ok).toBe(false);
    expect(liveLauncher(cfg.stateFile)?.mode).toBe("running");
    expect(starts(log, "mock")).toHaveLength(2); // stopped, then started again
    expect(existsSync(join(root, "src/noblecloak/worker.ts"))).toBe(true);
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("reset:full finds the launcher already paused (an earlier reset:full died) and finishes without toggling it twice", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    const cfg = await configFor(root);
    const l = await launch(root, cfg, join(tempDir(), "fake.log"));
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    process.kill(l.child.pid!, "SIGUSR2");
    await waitFor("paused", () => liveLauncher(cfg.stateFile)?.mode === "paused", 15_000);
    const started = Date.now();
    const lines: string[] = [];

    const out = await resetFull(cfg, { log: (m) => lines.push(m) });

    expect(out.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(lines.join("\n")).toMatch(/already paused/);
    expect(liveLauncher(cfg.stateFile)?.mode).toBe("running");
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("a second reset --rules on an installed tree that has already run works: agent.json is null before every worker start", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    put(root, "src/noblecloak/agent.json", '{"name":"x","id":null}\n');
    const cfg = await configFor(root);
    const dir = tempDir();
    const log = join(dir, "fake.log");
    // Like the real propose.mjs on a fresh mock: it declares the agent and writes its id, and it fails if an id is already there.
    put(dir, "plugin/setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs", `import { readFileSync, writeFileSync } from "node:fs";
const f = "src/noblecloak/agent.json"; const j = JSON.parse(readFileSync(f, "utf8"));
if (j.id !== null) { console.error("unknown_agent"); process.exit(2); }
writeFileSync(f, JSON.stringify({ ...j, id: "agt_" + Date.now() }));`);
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    const options = { rules: true, pluginDir: join(dir, "plugin") };

    const first = await resetRunCommand(cfg, { log: () => undefined }, options);
    expect(JSON.parse(readFileSync(join(root, "src/noblecloak/agent.json"), "utf8")).id).toMatch(/^agt_/);
    const second = await resetRunCommand(cfg, { log: () => undefined }, options);

    expect(first.rules).toBe("approved");
    expect(second.rules).toBe("approved");
    const seen = readFileSync(log, "utf8").split("\n").filter((x) => x.startsWith("workerSawAgentId"));
    expect(seen).toEqual(["workerSawAgentId null", "workerSawAgentId null", "workerSawAgentId null"]); // start, restart 1, restart 2
    l.child.kill("SIGINT");
    await l.exited;
  });

  it("reset --rules --no-approve opens the proposal and leaves the approval to the page", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    const cfg = await configFor(root);
    const dir = tempDir();
    const log = join(dir, "fake.log");
    put(dir, "plugin/setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs", "// ok\n");
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    const out = await resetRunCommand(cfg, { log: () => undefined }, { rules: true, approve: false, pluginDir: join(dir, "plugin") });
    expect(out.rules).toBe("opened");
    expect(readFileSync(log, "utf8")).not.toContain("approve ");
    l.child.kill("SIGINT");
    await l.exited;
  });
  it("creates .env.local for these ports when a fresh clone has none, and leaves an existing one alone", async () => {
    const root = makeRepo();
    const cfg = await configFor(root);
    const l = await launch(root, cfg, join(tempDir(), "fake.log"));
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe(`NC_BASE_URL=${cfg.mockUrl}\nNOBLECLOAK_SP_CREDENTIALS=.data/noblecloak-sp.credentials.json\nNC_EXPECTED_PRINCIPAL=svc_adapter\n`);
    l.child.kill("SIGINT");
    await l.exited;

    writeFileSync(join(root, ".env.local"), "NC_BASE_URL=mine\n");
    const again = await launch(root, cfg, join(tempDir(), "fake.log"));
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("NC_BASE_URL=mine\n");
    again.child.kill("SIGINT");
    await again.exited;
  });
  it("reset --rules finds the plugin itself when --plugin is omitted", async () => {
    const root = makeRepo();
    put(root, "src/noblecloak/worker.ts", "export {};\n");
    const cfg = await configFor(root); // its home is a throwaway directory
    const log = join(tempDir(), "fake.log");
    const installPath = join(cfg.home, ".claude/plugins/cache/noblecloak/noblecloak/9.9.9");
    put(installPath, "setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs", `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "propose-from-installed-plugin\\n");`);
    put(cfg.home, ".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: { "noblecloak@noblecloak": [{ scope: "user", installPath }] } }));
    const l = await launch(root, cfg, log);
    await waitFor("running", () => liveLauncher(cfg.stateFile)?.mode === "running", 15_000);
    const out = await resetRunCommand(cfg, { log: () => undefined }, { rules: true });
    expect(out.rules).toBe("approved");
    expect(readFileSync(log, "utf8")).toContain("propose-from-installed-plugin");
    l.child.kill("SIGINT");
    await l.exited;
  });
});
