// Fixtures for the script tests: throwaway git repos and fake mock / app servers. Nothing here touches a real checkout.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type DemoConfig } from "../demo-config";
import { startOf, type LauncherState } from "../demo-state";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

export function put(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

export function tempDir(prefix = "fernhill-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export const BASE = "base-branch";

/** A repo shaped like the demo: a base branch (pre-install) and a `governed` branch (the install on top of it). */
export function makeRepo(): string {
  const root = tempDir("fernhill-repo-");
  git(root, "init", "-q", "-b", BASE);
  git(root, "config", "user.email", "t@example.test");
  git(root, "config", "user.name", "t");
  put(root, ".gitignore", "node_modules/\n.env*\n!.env.example\n.data/\n.demo-launcher.json*\n.reset-backups/\n");
  put(root, ".env.example", "NC_BASE_URL=\n");
  put(root, "README.md", "readme\n");
  put(root, "package.json", '{"name":"x"}\n');
  put(root, "src/agent/start.ts", "export const build = 'plain';\n");
  put(root, "src/agent/start.test.ts", "// plain\n");
  put(root, "src/agent/agent.test.ts", "// plain\n");
  put(root, "demo/rules.plan.json", "{}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "governed");
  put(root, ".env.example", "NC_BASE_URL=\n# NobleCloak governance\nNC_AUDIENCE=\n");
  put(root, "src/agent/start.ts", "import './noblecloak/governance';\nexport const build = 'governed';\n");
  put(root, "src/agent/start.test.ts", "// mocks ../noblecloak/governance\n");
  put(root, "src/agent/agent.test.ts", "// mocks ../noblecloak/governed-agent\n");
  put(root, "src/noblecloak/agent.json", '{"id":null}\n');
  put(root, "src/noblecloak/governance.ts", "export {};\n");
  put(root, "src/noblecloak/worker.ts", "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "install");
  git(root, "checkout", "-q", BASE);
  return root;
}

export async function configFor(root: string): Promise<DemoConfig> {
  const cfg = loadConfig({ FERNHILL_APP_PORT: String(await freePort()), FERNHILL_MOCK_PORT: String(await freePort()), HOME: tempDir("fernhill-home-") }, root);
  return { ...cfg, baseBranch: BASE };
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** Listens on a port until closed. */
export async function serve(port: number, handler: Handler): Promise<{ close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

export const sendJson = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A live process whose command line ends with `script` (as `ps` shows `bun scripts/demo.ts`), standing in for a launcher or a worker. */
export async function standIn(script: string): Promise<{ pid: number; startedAt: string; startMs: number; stop: () => void }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)", "--", script], { stdio: "ignore" });
  const pid = child.pid!;
  const startedAt = new Date().toISOString();
  // ps knows the process once it exists; wait for it.
  for (let i = 0; i < 50 && startOf(pid) === null; i += 1) await new Promise((r) => setTimeout(r, 20));
  return { pid, startedAt, startMs: startOf(pid) ?? 0, stop: () => void child.kill("SIGKILL") };
}

/** A recorded launcher state whose launcher (and optionally mock and worker) are stand-in live processes. */
export async function liveState(cfg: DemoConfig, opts: { worker?: "ok" | "dead" | "reused" | "none"; workerBeforeMock?: boolean } = {}): Promise<{ state: LauncherState; stop: () => void }> {
  const stops: Array<() => void> = [];
  const launcherScript = join(cfg.root, "scripts/demo.ts");
  const launcher = await standIn("scripts/demo.ts");
  stops.push(launcher.stop);
  const mockStarted = new Date(Date.now() - 5000).toISOString();
  const children: LauncherState["children"] = { mock: { pid: launcher.pid, startedAt: mockStarted } };
  if (opts.worker === "ok") {
    const w = await standIn("src/noblecloak/worker.ts");
    stops.push(w.stop);
    children.worker = { pid: w.pid, startedAt: w.startedAt };
    // The worker is a real process started now; the mock is recorded as starting after it.
    if (opts.workerBeforeMock) children.mock = { pid: launcher.pid, startedAt: new Date(Date.parse(w.startedAt) + 10_000).toISOString() };
  } else if (opts.worker === "dead") children.worker = { pid: 2_147_483_000, startedAt: new Date().toISOString() };
  else if (opts.worker === "reused") children.worker = { pid: process.pid, startedAt: new Date().toISOString() };
  const state: LauncherState = { pid: launcher.pid, root: cfg.root, script: launcherScript, procStartMs: launcher.startMs, startedAt: launcher.startedAt, appPort: cfg.appPort, mockPort: cfg.mockPort, mode: "running", generation: 1, children };
  return { state, stop: () => stops.forEach((f) => f()) };
}
