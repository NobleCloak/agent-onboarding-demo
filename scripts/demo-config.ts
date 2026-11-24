// Settings shared by the demo launcher, the resets and preflight. Plain Node APIs only, so Bun and Vitest can both load it.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { modeOf, type Mode } from "../lib/mode";

/**
 * The branch `bun run demo:new` clones and `bun run reset:full` returns to: the pre-install state. Tests pass their own
 * branch name (see `baseBranch` in the options and in DemoConfig), so they do not depend on this value.
 */
export const BASE_BRANCH = "main";

/** The fallback: the install already applied. `demo:new` checks that a fresh copy can fetch it. */
export const GOVERNED_BRANCH = "demo/governed";

/**
 * What the NobleCloak install changes in the checkout. `reset:full` restores or removes exactly these and refuses when
 * anything else in the tree differs. (.env.local, .data/ and node_modules are git-ignored and not listed.)
 */
export const INSTALL_PATHS = {
  /** Removed whole: the generated governance, worker and agent id live here. */
  dirs: ["src/noblecloak"],
  /** Restored from the base branch. */
  files: [".env.example", "src/agent/start.ts", "src/agent/start.test.ts", "src/agent/agent.test.ts"],
} as const;

/** An uncommitted edit to a known tracked file counts as the install's own only if it adds a line that names NobleCloak. */
export const INSTALL_EDIT_MARKER = /noblecloak/i;
/** Where `reset:full` saves what it is about to discard. Git-ignored, and not in .data/ because .data/ is cleared. */
export const BACKUP_DIR = ".reset-backups";

export const DEFAULT_APP_PORT = 3417;
export const DEFAULT_MOCK_PORT = 8787;
export const SERVICE_PRINCIPAL = "svc_adapter";
export const CREDENTIAL_PATH = ".data/noblecloak-sp.credentials.json";
export const RULES_PLAN = "demo/rules.plan.json";
export const WORKER_FILE = "src/noblecloak/worker.ts";
export const FERNHILL_TOOL_PREFIX = "ext:fernhill-desk:";

export type DemoConfig = {
  /** `mock` (default) or `deployment`: NEXT_PUBLIC_FERNHILL_MODE. Deployment mode never starts or touches the mock. */
  mode: Mode;
  /** The agent's service-principal credential: the mock's, under .data/, or in deployment mode the file NOBLECLOAK_SP_CREDENTIALS names ("" when unset). */
  credentialFile: string;
  root: string;
  home: string;
  baseBranch: string;
  appPort: number;
  mockPort: number;
  appUrl: string;
  mockUrl: string;
  dataDir: string;
  stateFile: string;
};

const port = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number, got "${raw}"`);
  return n;
};

/** FERNHILL_APP_PORT and FERNHILL_MOCK_PORT move the ports, so tests and rehearsals can run beside the real demo. */
export function loadConfig(env: Record<string, string | undefined> = process.env, root: string = process.cwd()): DemoConfig {
  const appPort = port(env.FERNHILL_APP_PORT, DEFAULT_APP_PORT, "FERNHILL_APP_PORT");
  const mockPort = port(env.FERNHILL_MOCK_PORT, DEFAULT_MOCK_PORT, "FERNHILL_MOCK_PORT");
  const absRoot = resolve(root);
  const mode = modeOf(env);
  const deployed = mode === "deployment";
  const named = (env.NOBLECLOAK_SP_CREDENTIALS ?? "").trim();
  return {
    mode,
    credentialFile: deployed ? (named === "" ? "" : resolve(absRoot, named)) : join(absRoot, CREDENTIAL_PATH),
    root: absRoot,
    home: env.HOME ?? homedir(),
    baseBranch: BASE_BRANCH,
    appPort,
    mockPort,
    // Deployment mode is opened at localhost: the module requires the redirect on the page's own origin, and this app's config check accepts only https or http://localhost for it.
    appUrl: `http://${deployed ? "localhost" : "127.0.0.1"}:${appPort}`,
    mockUrl: `http://127.0.0.1:${mockPort}`,
    dataDir: join(absRoot, ".data"),
    stateFile: join(absRoot, ".demo-launcher.json"),
  };
}

/** What the commands that only make sense against the local mock say in deployment mode, or null in mock mode. */
export function mockOnlyRefusal(mode: Mode, command: string): string | null {
  return mode === "deployment" ? `${command} is mock only. NEXT_PUBLIC_FERNHILL_MODE=deployment is set, and a real deployment's rules, approvals and credentials are never reset from here. Unset it to use the mock.` : null;
}

/** For the command line entry points of the mock-only commands: a one-line refusal and exit 1 in deployment mode. */
export function refuseInDeployment(command: string, env: Record<string, string | undefined> = process.env): void {
  let refusal: string | null;
  try {
    refusal = mockOnlyRefusal(modeOf(env), command);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  if (refusal) {
    console.error(`REFUSED: ${refusal}`);
    process.exit(1);
  }
}

/** The three values the app and the worker read, for these ports. `.env.local` must say the same. */
export const ncEnv = (cfg: Pick<DemoConfig, "mockUrl">) => ({
  NC_BASE_URL: cfg.mockUrl,
  NOBLECLOAK_SP_CREDENTIALS: CREDENTIAL_PATH,
  NC_EXPECTED_PRINCIPAL: SERVICE_PRINCIPAL,
});

/**
 * The checkout these scripts belong to: the git top level of the directory above this file. Refuses (throws) unless
 * the shell is standing in exactly that directory, so a script never acts on a checkout it was not invoked from.
 */
export function requireRoot(cwd: string = process.cwd(), scriptDir: string = dirname(fileURLToPath(import.meta.url))): string {
  const root = realpathSync(resolve(scriptDir, ".."));
  let top: string;
  try {
    top = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  } catch {
    throw new Error(`${root} is not a git checkout, so these scripts will not act on it.`);
  }
  if (top !== root) throw new Error(`${root} is inside the git checkout ${top}, not its top level, so these scripts will not act on it.`);
  if (realpathSync(cwd) !== root) throw new Error(`Run this from ${root} (the shell is in ${cwd}).`);
  return root;
}

/** For the command line entry points: the config for this checkout, or a one-line refusal and exit 1. */
export function entryConfig(): DemoConfig {
  try {
    return loadConfig(process.env, requireRoot());
  } catch (error) {
    console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/** The one place `.env.local` is written (the launcher and the mock both call it): the three values the app and the worker read. */
export function writeEnvLocalIfMissing(file: string, mockUrl: string): boolean {
  if (existsSync(file)) return false; // may be someone's own
  writeFileSync(file, Object.entries(ncEnv({ mockUrl })).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return true;
}
