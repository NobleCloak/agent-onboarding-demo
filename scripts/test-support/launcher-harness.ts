// Runs the real launcher against fake children. env: FERNHILL_APP_PORT, FERNHILL_MOCK_PORT, FAKE_LOG, HARNESS_WORKER=1.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../demo-config";
import { runLauncher, type Spec } from "../demo";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fake-child.mjs");
const cfg = loadConfig(process.env, process.cwd());
// Deployment mode has no mock: the real launcher starts the app (and the worker), so the fakes do the same.
const all = (): Spec[] => [
  { name: "mock", cmd: "node", args: [fake, "mock", String(cfg.mockPort)], env: {}, ready: { http: `${cfg.mockUrl}/__mock/tokens` }, readyTimeoutMs: 10_000 },
  { name: "app", cmd: "node", args: [fake, "app", String(cfg.appPort)], env: {}, ready: { http: `${cfg.appUrl}/api/run` }, readyTimeoutMs: 10_000 },
  ...(existsSync(join(cfg.root, "src/noblecloak/worker.ts")) ? [{ name: "worker" as const, cmd: "node", args: [fake, "worker", "-"], env: {}, ready: { line: "worker_ready" }, readyTimeoutMs: 10_000 }] : []),
];
const specs = (): Spec[] => all().filter((spec) => cfg.mode !== "deployment" || spec.name !== "mock");
// FAKE_FAST shortens the watcher's timings so tests finish quickly.
const fast = process.env.FAKE_FAST ? { pollMs: 100, earlyExitMs: 1500, retryDelayMs: 150, maxFailures: 3 } : {};
runLauncher(cfg, specs, fast).then((code) => process.exit(code));
