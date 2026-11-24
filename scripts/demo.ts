// `bun run demo`: starts the local NobleCloak mock, the app, and the worker (when src/noblecloak/worker.ts exists) together.
//
// Why together: a mock restart makes new signing keys, and a worker left running across it holds a dead token and stalls
// forever. So the worker is only ever started by this launcher, right after the mock it belongs to.
//
// Rules this file keeps: it fails before starting anything when a port is taken (it never attaches to a process that is
// already there), it signals only the pids it spawned, and Ctrl-C stops all of them.
//
// While running it also watches for the install: once src/noblecloak/worker.ts (and what it imports) is complete it starts
// the worker itself, restarts one that exits within a short window (a file still being written) a few times, and stops it
// if the file goes away. Nobody should start the worker by hand: preflight only accepts the launcher's.
//
// Control for `reset` and `reset:full` (same user, same machine): SIGUSR1 restarts the mock and the worker; SIGUSR2
// stops everything and waits (mode "paused" in .demo-launcher.json), or starts everything again when paused.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CREDENTIAL_PATH, DEFAULT_MOCK_PORT, WORKER_FILE, entryConfig, ncEnv, writeEnvLocalIfMissing, type DemoConfig } from "./demo-config";
import { liveLauncher, listenerOf, portInUse, removeState, sleep, startOf, waitFor, writeState, type ChildName, type LauncherState } from "./demo-state";

export type Ready = { http: string } | { line: string };
export type Spec = { name: ChildName; cmd: string; args: string[]; env: Record<string, string>; ready: Ready; readyTimeoutMs: number };
export type SpecsFor = (cfg: DemoConfig) => Spec[];

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * Is the install complete enough to start the worker? worker.ts is non-empty, every relative file it imports exists and is
 * non-empty (a file being written is not), and the credential the mock wrote is there. A session writes these files one
 * at a time, so this keeps the launcher from starting a worker that would fail on a missing import.
 */
export function workerReady(cfg: DemoConfig): boolean {
  const file = join(cfg.root, WORKER_FILE);
  if (sizeOf(file) === 0 || cfg.credentialFile === "" || sizeOf(cfg.credentialFile) === 0) return false;
  const imports = [...readFileSync(file, "utf8").matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => join(dirname(file), m[1]!));
  return imports.every((base) => [base, base.replace(/\.js$/, ".ts"), `${base}.ts`].some((c) => sizeOf(c) > 0));
}

/** The real commands. The worker is included only when it is installed, so a pre-install tree starts two processes. */
export const realSpecs: SpecsFor = (cfg) => {
  if (cfg.mode === "deployment") return deploymentSpecs(cfg);
  const nc = ncEnv(cfg);
  const specs: Spec[] = [
    {
      name: "mock",
      cmd: "bun",
      args: ["scripts/noblecloak-local.ts"],
      // On the default port the mock also writes .env.local when it is missing. On another port it writes only the credential.
      env: { ...(cfg.mockPort === DEFAULT_MOCK_PORT ? {} : { NC_LOCAL_PORT: String(cfg.mockPort) }), NC_LOCAL_CREDENTIAL_FILE: CREDENTIAL_PATH, FERNHILL_APP_PORT: String(cfg.appPort) },
      ready: { http: `${cfg.mockUrl}/__mock/tokens` },
      readyTimeoutMs: 30_000,
    },
    {
      name: "app",
      cmd: join(cfg.root, "node_modules/.bin/next"),
      args: ["dev", "-p", String(cfg.appPort), "-H", "127.0.0.1"],
      env: { ...nc, FERNHILL_ALLOWED_ORIGINS: `http://127.0.0.1:${cfg.appPort},http://localhost:${cfg.appPort}`, NEXT_TELEMETRY_DISABLED: "1" },
      ready: { http: `${cfg.appUrl}/api/run` },
      readyTimeoutMs: 120_000,
    },
  ];
  if (workerReady(cfg)) {
    specs.push({
      name: "worker",
      cmd: "node",
      args: ["--env-file-if-exists=.env.local", "--import", "tsx", WORKER_FILE],
      env: nc,
      ready: { line: "worker_ready" },
      readyTimeoutMs: 30_000,
    });
  }
  return specs;
};

/**
 * Deployment mode: the app (bound to localhost, the address the sign-in returns to) and the worker. No mock. The
 * deployment's address, the sign-in settings and the credential file come from the environment the operator set
 * (.env.local), which the app and the worker read themselves; nothing here writes or defaults them.
 */
export const deploymentSpecs: SpecsFor = (cfg) => {
  const specs: Spec[] = [
    {
      name: "app",
      cmd: join(cfg.root, "node_modules/.bin/next"),
      args: ["dev", "-p", String(cfg.appPort), "-H", "localhost"],
      env: { NEXT_PUBLIC_FERNHILL_MODE: "deployment", FERNHILL_ALLOWED_ORIGINS: `http://localhost:${cfg.appPort}`, NEXT_TELEMETRY_DISABLED: "1" },
      // /api/run is 401 until someone signs in, so readiness is the unauthenticated /api/health.
      ready: { http: `${cfg.appUrl}/api/health` },
      readyTimeoutMs: 120_000,
    },
  ];
  if (workerReady(cfg)) {
    specs.push({ name: "worker", cmd: "node", args: ["--env-file-if-exists=.env.local", "--import", "tsx", WORKER_FILE], env: {}, ready: { line: "worker_ready" }, readyTimeoutMs: 30_000 });
  }
  return specs;
};

const say = (message: string) => console.log(`[demo] ${message}`);

/** Fail-fast check, run before anything starts. Returns the problems, empty when both ports are free. */
export async function portProblems(cfg: DemoConfig): Promise<string[]> {
  const problems: string[] = [];
  const watched = cfg.mode === "deployment" ? ([["app", cfg.appPort]] as const) : ([["app", cfg.appPort], ["NobleCloak mock", cfg.mockPort]] as const);
  for (const [what, port] of watched) {
    if (await portInUse(port)) {
      const who = listenerOf(port);
      problems.push(`port ${port} (${what}) is already in use${who ? ` by ${who}` : ""}. Demo did not start anything and did not touch that process. Stop it yourself, or set FERNHILL_APP_PORT / FERNHILL_MOCK_PORT.`);
    }
  }
  return problems;
}

type Running = { spec: Spec; child: ChildProcess; exited: boolean; ready: boolean; startedMs: number };

export type LauncherOptions = {
  /** How often to look for worker.ts appearing or disappearing. */
  pollMs?: number;
  /** A worker that exits sooner than this after it started counts as a failed start. */
  earlyExitMs?: number;
  retryDelayMs?: number;
  /** Failed starts in a row before the launcher gives up until worker.ts changes. */
  maxFailures?: number;
};

export async function runLauncher(cfg: DemoConfig, specsFor: SpecsFor, options: LauncherOptions = {}): Promise<number> {
  const opts = { pollMs: 500, earlyExitMs: 5000, retryDelayMs: 1000, maxFailures: 3, ...options };
  const existing = liveLauncher(cfg.stateFile);
  if (existing) {
    console.error(`[demo] already running here (pid ${existing.pid}). Stop it with Ctrl-C in its terminal first.`);
    return 1;
  }
  const problems = await portProblems(cfg);
  if (problems.length) {
    for (const p of problems) console.error(`[demo] ${p}`);
    return 1;
  }
  mkdirSync(cfg.dataDir, { recursive: true });
  // A fresh clone has no .env.local (it is git-ignored). Write the three values for these ports; never touch an existing file.
  if (cfg.mode === "mock" && writeEnvLocalIfMissing(join(cfg.root, ".env.local"), cfg.mockUrl)) say("wrote .env.local (it was missing)");

  const running = new Map<ChildName, Running>();
  const state: LauncherState = { pid: process.pid, root: cfg.root, script: resolve(process.argv[1] ?? "demo"), procStartMs: startOf(process.pid) ?? 0, startedAt: new Date().toISOString(), appPort: cfg.appPort, mockPort: cfg.mockPort, mode: "starting", generation: 0, children: {} };
  const save = () => writeState(cfg.stateFile, state);
  let stopping = false;
  let busy = false;
  /** Signals that arrived while busy. A dropped one leaves `reset` waiting 90 s for a restart that never comes. */
  const queued: Array<() => Promise<void>> = [];
  /** Runs what `action` asks for now, or after whatever the launcher is busy with. */
  const whenIdle = (action: () => Promise<void>) => {
    queued.push(action);
    void drainQueue();
  };
  let done: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => (done = resolve));

  const pipe = (name: string, stream: NodeJS.ReadableStream, onLine?: (line: string) => void) => {
    let rest = "";
    stream.on("data", (chunk: Buffer) => {
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        console.log(`[${name}] ${line}`);
        onLine?.(line);
      }
    });
  };

  async function start(spec: Spec): Promise<void> {
    let markerSeen: () => void = () => undefined;
    const seen = new Promise<void>((resolve) => (markerSeen = resolve));
    const child = spawn(spec.cmd, spec.args, { cwd: cfg.root, env: { ...process.env, ...spec.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const entry: Running = { spec, child, exited: false, ready: false, startedMs: Date.now() };
    running.set(spec.name, entry);
    const marker = "line" in spec.ready ? spec.ready.line : null;
    pipe(spec.name, child.stdout!, (line) => marker && line.includes(marker) && markerSeen());
    pipe(spec.name, child.stderr!, (line) => marker && line.includes(marker) && markerSeen());
    child.once("error", (error) => {
      entry.exited = true;
      say(`could not start ${spec.name}: ${error.message}`);
      void shutdown(1);
    });
    child.once("exit", (code, signal) => {
      entry.exited = true;
      // The worker is the launcher's to retry (it may be a file still being written), not a reason to stop everything.
      if (spec.name === "worker") {
        if (!stopping && entry.ready && running.get("worker") === entry) onWorkerExit(entry, code, signal);
        return;
      }
      if (!stopping && running.get(spec.name) === entry && !busy) {
        say(`${spec.name} exited unexpectedly (${signal ?? `code ${code}`}). Stopping the rest so nothing is left half-working.`);
        void shutdown(1);
      }
    });
    state.children[spec.name] = { pid: child.pid!, startedAt: new Date().toISOString() };
    save();
    if ("http" in spec.ready) {
      const url = spec.ready.http;
      await waitFor(`${spec.name} at ${url}`, async () => {
        if (entry.exited) throw new Error(`${spec.name} exited before it was ready`);
        return fetch(url).then((r) => r.ok, () => false);
      }, spec.readyTimeoutMs);
    } else {
      const diedFirst = new Promise<never>((_, reject) => child.once("exit", () => reject(new Error(`${spec.name} exited before it was ready`))));
      diedFirst.catch(() => undefined); // only read through the race below
      await Promise.race([seen, diedFirst, sleep(spec.readyTimeoutMs).then(() => { throw new Error(`${spec.name} did not print "${marker}" in time`); })]);
    }
    entry.ready = true;
    say(`${spec.name} ready`);
  }

  async function stop(name: ChildName): Promise<void> {
    const entry = running.get(name);
    if (!entry) return;
    running.delete(name);
    delete state.children[name];
    const pid = entry.child.pid;
    if (entry.exited || pid === undefined) return;
    const exited = new Promise<void>((resolve) => entry.child.once("exit", () => resolve()));
    // Only the group this launcher created for the child (detached: true), never anything else.
    try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
    await Promise.race([exited, sleep(4000)]);
    if (!entry.exited) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      await Promise.race([exited, sleep(2000)]);
    }
  }

  // ---- the worker: started whenever the install is complete, retried a few times, stopped when the file goes away
  let workerFailures = 0;
  let workerRetryAt = 0;
  let workerGaveUpAt: number | null = null; // worker.ts's mtime when the launcher gave up
  const workerMtime = (): number | null => {
    try {
      return statSync(join(cfg.root, WORKER_FILE)).mtimeMs;
    } catch {
      return null;
    }
  };

  function noteWorkerFailure(lifetimeMs: number): void {
    workerFailures = lifetimeMs < opts.earlyExitMs ? workerFailures + 1 : 1;
    if (workerFailures >= opts.maxFailures) {
      workerGaveUpAt = workerMtime();
      state.workerNote = `gave up after ${workerFailures} quick exits of the worker; will retry when src/noblecloak/worker.ts changes. Read the [worker] lines above.`;
      say(`the worker failed ${workerFailures} times in a row; ${state.workerNote}`);
    } else {
      workerRetryAt = Date.now() + opts.retryDelayMs;
      say(`the worker exited after ${Math.round(lifetimeMs)} ms (attempt ${workerFailures} of ${opts.maxFailures}); trying again shortly. A file still being written does this.`);
    }
    save();
  }

  function onWorkerExit(entry: Running, code: number | null, signal: NodeJS.Signals | null): void {
    running.delete("worker");
    delete state.children.worker;
    say(`the worker exited (${signal ?? `code ${code}`})`);
    noteWorkerFailure(Date.now() - entry.startedMs);
  }

  /** Never throws: a worker that cannot start is retried by the watcher, not a reason to stop the demo. */
  async function startWorker(spec: Spec): Promise<void> {
    const startedMs = Date.now();
    try {
      await start(spec);
      workerFailures = 0;
      delete state.workerNote;
      workerGaveUpAt = null;
      save();
    } catch (error) {
      const entry = running.get("worker");
      if (entry) {
        running.delete("worker");
        delete state.children.worker;
        try { process.kill(-entry.child.pid!, "SIGKILL"); } catch { /* already gone */ }
      }
      say(`worker did not start: ${error instanceof Error ? error.message : String(error)}`);
      noteWorkerFailure(Date.now() - startedMs);
    }
  }

  async function drainQueue(): Promise<void> {
    while (!busy && !stopping && queued.length > 0) await queued.shift()!();
  }

  async function watchWorker(): Promise<void> {
    await drainQueue();
    if (busy || stopping || state.mode !== "running") return;
    const spec = specsFor(cfg).find((s) => s.name === "worker");
    if (running.has("worker") && !spec) {
      busy = true;
      try {
        say(`${WORKER_FILE} is gone (or incomplete): stopping the worker`);
        await stop("worker");
        workerFailures = 0;
        delete state.workerNote;
        save();
      } finally {
        busy = false;
      }
    } else if (!running.has("worker") && spec) {
      if (workerGaveUpAt !== null) {
        if (workerMtime() === workerGaveUpAt) return;
        workerGaveUpAt = null;
        workerFailures = 0;
        delete state.workerNote;
      }
      if (Date.now() < workerRetryAt) return;
      busy = true;
      try {
        say(`${WORKER_FILE} is ready: starting the worker`);
        await startWorker(spec);
      } finally {
        busy = false;
      }
    }
  }

  async function startAll(): Promise<void> {
    const specs = specsFor(cfg);
    const by = (n: ChildName) => specs.find((s) => s.name === n);
    // The mock first (it writes the credential), then the rest together.
    const mock = by("mock");
    if (mock) await start(mock);
    const worker = by("worker");
    await Promise.all([...specs.filter((s) => s.name !== "mock" && s.name !== "worker").map(start), ...(worker ? [startWorker(worker)] : [])]);
  }

  async function stopAll(): Promise<void> {
    for (const name of ["worker", "app", "mock"] as const) await stop(name);
  }

  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    say("stopping everything this launcher started");
    await stopAll();
    removeState(cfg.stateFile);
    done(code);
  }

  /** SIGUSR1: restart the mock and the worker together (the worker would otherwise keep a dead token). */
  async function restartMock(): Promise<void> {
    if (busy || stopping || state.mode !== "running" || cfg.mode === "deployment") return;
    busy = true;
    state.mode = "restarting";
    save();
    try {
      say("restarting the mock and the worker");
      await stop("worker");
      await stop("mock");
      const specs = specsFor(cfg);
      const mock = specs.find((s) => s.name === "mock");
      if (mock) await start(mock);
      const worker = specs.find((s) => s.name === "worker");
      if (worker) await startWorker(worker);
      state.mode = "running";
      state.generation += 1;
      save();
    } catch (error) {
      say(`restart failed: ${error instanceof Error ? error.message : String(error)}`);
      busy = false;
      await shutdown(1);
    } finally {
      busy = false;
    }
  }

  /** SIGUSR2: pause (stop everything) or resume (start everything again, re-reading which processes the tree needs). */
  async function togglePause(): Promise<void> {
    if (busy || stopping) return;
    busy = true;
    try {
      if (state.mode === "running") {
        state.mode = "restarting";
        save();
        await stopAll();
        state.mode = "paused";
        state.generation += 1;
        save();
        say("paused: everything stopped, waiting");
      } else if (state.mode === "paused") {
        state.mode = "restarting";
        save();
        await startAll();
        state.mode = "running";
        state.generation += 1;
        save();
        say("resumed");
      }
    } catch (error) {
      say(`${state.mode === "restarting" ? "resume" : "pause"} failed: ${error instanceof Error ? error.message : String(error)}`);
      busy = false;
      await shutdown(1);
    } finally {
      busy = false;
    }
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGHUP", () => void shutdown(0));
  process.on("SIGUSR1", () => whenIdle(restartMock));
  process.on("SIGUSR2", () => whenIdle(togglePause));

  save();
  try {
    await startAll();
    state.mode = "running";
    state.generation += 1;
    save();
    const deployed = cfg.mode === "deployment";
    const worker = state.children.worker ? (deployed ? "app and worker" : "mock, app and worker") : `${deployed ? "app" : "mock and app"} (no worker yet: it starts by itself once ${WORKER_FILE} is complete${deployed ? " and the credential file NOBLECLOAK_SP_CREDENTIALS names exists" : ""})`;
    const timer = setInterval(() => void watchWorker().catch((e) => say(`watching for the worker failed: ${e instanceof Error ? e.message : String(e)}`)), opts.pollMs);
    void finished.then(() => clearInterval(timer));
    say(`up: ${worker}. App ${cfg.appUrl}${deployed ? "  (deployment mode: no mock)" : `  Mock ${cfg.mockUrl}`}  Ctrl-C stops everything.`);
  } catch (error) {
    say(`start failed: ${error instanceof Error ? error.message : String(error)}`);
    await shutdown(1);
  }
  return finished;
}

if (process.argv[1]?.endsWith("scripts/demo.ts")) {
  runLauncher(entryConfig(), realSpecs).then((code) => process.exit(code));
}

