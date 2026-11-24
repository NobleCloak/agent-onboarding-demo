// `bun run preflight`: one check that says whether it is safe to begin the demo. Exits non-zero and names every item
// that failed. Read-only: it changes nothing in the checkout, the app or the mock.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { CREDENTIAL_PATH, FERNHILL_TOOL_PREFIX, RULES_PLAN, SERVICE_PRINCIPAL, WORKER_FILE, entryConfig, ncEnv, type DemoConfig } from "./demo-config";
import { modeOf, tighterOf, type Mode } from "./rule-modes";
import { isSecureUrl, parseDeploymentConfig } from "../lib/mode";
import { isRecordedProcess, liveLauncher, startOf } from "./demo-state";

export type Check = { name: string; status: "pass" | "fail" | "warn"; detail: string };
export type Report = { checks: Check[]; ok: boolean };
export type Deps = {
  fetch?: typeof fetch;
  /** True when the checkout is where ~/bianoble/CLAUDE.md would load. */
  pathUnderBianoble?: (root: string, home: string) => boolean;
  /** Worker processes running from this checkout, to name one in the message when the launcher is not running. */
  findWorkers?: (root: string) => Array<{ pid: number; startedAt: number | null }>;
  /** Deployment mode: the environment to check. Defaults to the process's (Bun has already read .env.local into it). */
  env?: Record<string, string | undefined>;
};

const underBianoble = (root: string, home: string) => root.startsWith(join(home, "bianoble") + sep);

/** Best effort and local only: ps for worker.ts processes, kept if lsof says their cwd is this checkout. */
function scanWorkers(root: string): Array<{ pid: number; startedAt: number | null }> {
  try {
    const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
    const found: Array<{ pid: number; startedAt: number | null }> = [];
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || !m[2]!.includes(WORKER_FILE)) continue;
      const pid = Number(m[1]);
      const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("n"))?.slice(1);
      if (cwd === root) found.push({ pid, startedAt: startOf(pid) });
    }
    return found;
  } catch {
    return [];
  }
}

const parseEnvFile = (text: string): Record<string, string> =>
  Object.fromEntries(text.split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, "")]));

/**
 * Deployment mode: is the environment ready to run against a real deployment? Local and read-only. It checks that the
 * settings and the credential file are there and consistent; it makes no network call, and it never starts, reaches
 * or mentions the mock. Whether the deployment accepts them is what the first sign-in shows.
 */
export function runDeploymentPreflight(cfg: DemoConfig, deps: Deps = {}): Report {
  const env = deps.env ?? process.env;
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });
  const read = (name: string) => (env[name] ?? "").trim();
  add("mode", "pass", "deployment: no mock is started or contacted");

  const api = read("NC_BASE_URL");
  if (api === "") add("api", "fail", "NC_BASE_URL is not set (the deployment's API origin, for example https://govern.noblecloak.com)");
  else if (!isSecureUrl(api)) add("api", "fail", "NC_BASE_URL uses https (or http://localhost)");
  else if (api !== read("NEXT_PUBLIC_NC_API_URL")) add("api", "fail", `NC_BASE_URL (${api}) must equal NEXT_PUBLIC_NC_API_URL (${read("NEXT_PUBLIC_NC_API_URL") || "not set"}): the sign-in names that origin as the token's audience, and this app forwards the token there`);
  else add("api", "pass", api);

  const signIn = parseDeploymentConfig(env);
  if (!signIn.ok) for (const problem of signIn.problems) add("sign-in", "fail", problem);
  else {
    const here = new URL(cfg.appUrl).origin;
    if (new URL(signIn.config.redirectUri).origin !== here) add("sign-in", "fail", `NEXT_PUBLIC_NC_REDIRECT_URI must be on ${here}, the address the app is opened at (the sign-in module requires the page's own origin)`);
    else add("sign-in", "pass", `client ${signIn.config.clientId}, returns to ${signIn.config.redirectUri}`);
  }

  const named = read("NOBLECLOAK_SP_CREDENTIALS");
  if (named === "") add("credentials", "fail", "NOBLECLOAK_SP_CREDENTIALS is not set (the agent's service-principal credential file, kept outside this repo)");
  else {
    const file = cfg.credentialFile;
    if (!existsSync(file)) add("credentials", "fail", `${named} does not exist. Create it with: npx @noblecloak/cli sp create (docs/deployment-mode.md)`);
    else if (file.startsWith(cfg.root + sep)) add("credentials", "fail", `${named} is inside this repo. Keep the credential outside it`);
    else {
      try {
        const credential = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        if (typeof credential.client_id !== "string" || credential.client_id === "") add("credentials", "fail", `${named} has no client_id`);
        else if (typeof credential.token_endpoint === "string" && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(credential.token_endpoint)) add("credentials", "fail", `${named} points at a local address, not a deployment. It looks like the mock's credential`);
        else add("credentials", "pass", `${named} (client ${credential.client_id})`);
      } catch {
        add("credentials", "fail", `${named} is not valid JSON`);
      }
    }
  }

  const principal = read("NC_EXPECTED_PRINCIPAL");
  if (principal === "") add("principal", "fail", "NC_EXPECTED_PRINCIPAL is not set (the id `sp create` printed)");
  else if (principal === SERVICE_PRINCIPAL) add("principal", "fail", `NC_EXPECTED_PRINCIPAL is ${SERVICE_PRINCIPAL}, the mock's. Use the service principal \`sp create\` made`);
  else add("principal", "pass", principal);

  if (existsSync(join(cfg.root, WORKER_FILE))) add("install", "pass", `${WORKER_FILE} is present`);
  else add("install", "warn", `${WORKER_FILE} is not there yet: run /noblecloak-setup (langgraph) in Claude Code`);
  return { checks, ok: !checks.some((c) => c.status === "fail") };
}

const versionParts = (v: string): [number, number, number] | undefined => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
const compareVersions = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether `installed` meets `declared`: an exact version, or `>=x.y.z <a.b.c`. Any other range form does not match. */
export function satisfiesDeclared(installed: string, declared: string): boolean {
  const have = versionParts(installed);
  if (!have) return false;
  const exact = versionParts(declared);
  if (exact) return compareVersions(have, exact) === 0;
  const range = /^>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+\.\d+\.\d+)$/.exec(declared.trim());
  if (!range) return false;
  return compareVersions(have, versionParts(range[1])!) >= 0 && compareVersions(have, versionParts(range[2])!) < 0;
}

export async function runPreflight(cfg: DemoConfig, deps: Deps = {}): Promise<Report> {
  if (cfg.mode === "deployment") return runDeploymentPreflight(cfg, deps);
  const doFetch = deps.fetch ?? fetch;
  const installed = existsSync(join(cfg.root, WORKER_FILE));
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });
  const get = async (url: string, token?: string): Promise<{ status: number; body: any } | null> => {
    try {
      const res = await doFetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return null;
    }
  };

  // Mock: reachable, and the local mock (only it serves /__mock/tokens, and its audience is this loopback address).
  let admin: string | null = null;
  const tokens = await get(`${cfg.mockUrl}/__mock/tokens`);
  if (!tokens) add("mock", "fail", `nothing answers at ${cfg.mockUrl}. Start it with: bun run demo`);
  else if (tokens.status !== 200 || typeof tokens.body?.admin !== "string") add("mock", "fail", `${cfg.mockUrl} answers but is not the local NobleCloak mock (no /__mock/tokens). Is another service on this port?`);
  else if (tokens.body.audience !== cfg.mockUrl) add("mock", "fail", `the mock at ${cfg.mockUrl} reports audience ${String(tokens.body.audience)}, so it is not the local mock for this port`);
  else {
    admin = tokens.body.admin as string;
    add("mock", "pass", `Local NobleCloak mock at ${cfg.mockUrl}`);
  }

  // App and run.
  const run = await get(`${cfg.appUrl}/api/run`);
  if (!run || run.status !== 200) {
    add("app", "fail", `the app does not answer at ${cfg.appUrl}${run ? ` (HTTP ${run.status})` : ""}. Start it with: bun run demo`);
    add("run", "fail", "not checked: the app is not reachable");
  } else {
    add("app", "pass", cfg.appUrl);
    const state = String(run.body?.state);
    if (state === "idle") add("run", "pass", "idle, nothing left over");
    else add("run", "fail", `a ${state} run is left over. Clear it with: bun run reset`);
  }

  // Worker. On an installed tree it must be the one `bun run demo` started with the current mock: the recorded pid is
  // checked against its command line and start time, so a reused pid or a hand-started worker does not pass.
  if (!installed) add("worker", "pass", "NobleCloak is not installed, so no worker is needed");
  else {
    const launcher = liveLauncher(cfg.stateFile);
    const worker = launcher?.children.worker;
    const mockStarted = launcher?.children.mock ? Date.parse(launcher.children.mock.startedAt) : NaN;
    if (!launcher) {
      const strangers = (deps.findWorkers ?? scanWorkers)(cfg.root);
      add("worker", "fail", `${strangers.length ? `a worker is running (pid ${strangers[0]!.pid}) but \`bun run demo\` did not start it, so it may hold a dead token. ` : "no worker is running. "}Stop it and start everything through: bun run demo`);
    } else if (!worker) {
      add("worker", "fail", launcher.workerNote
        ? `the launcher has no worker: ${launcher.workerNote}`
        : `NobleCloak's files are in place but the launcher has not started the worker yet. It starts it by itself, within a few seconds, once ${WORKER_FILE}, the files it imports and the credential are complete. If this stays, look at the [worker] lines in the \`bun run demo\` terminal; do not start a worker by hand.`);
    }
    else if (!isRecordedProcess(worker.pid, cfg.root, join(cfg.root, WORKER_FILE), Date.parse(worker.startedAt))) add("worker", "fail", `the recorded worker (pid ${worker.pid}) is not running ${WORKER_FILE} any more. Restart the demo with: bun run demo`);
    else if (!Number.isNaN(mockStarted) && Date.parse(worker.startedAt) < mockStarted) add("worker", "fail", "the worker started before the mock, so it holds a dead token and will stall. Restart together with: bun run reset");
    else add("worker", "pass", `running (pid ${worker.pid}), started by the demo with the current mock`);
  }

  // Pending approvals, and the rules.
  if (!admin) {
    add("approvals", "fail", "not checked: the mock is not reachable");
    add("rules", "fail", "not checked: the mock is not reachable");
  } else {
    const list = async (path: string): Promise<any[] | null> => {
      const out: any[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(`${cfg.mockUrl}${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, admin!);
        if (!res || res.status !== 200 || !Array.isArray(res.body?.data)) return null;
        out.push(...res.body.data);
        cursor = res.body.meta?.next ?? null;
      } while (cursor);
      return out;
    };
    const pending = await list("/v1/approvals?state=pending");
    if (!pending) add("approvals", "fail", "could not read the mock's approvals");
    else if (pending.length) add("approvals", "fail", `${pending.length} approval(s) still pending (${pending.slice(0, 3).map((a) => String(a.id)).join(", ")}). Clear them with: bun run reset`);
    else add("approvals", "pass", "none pending");

    const tools = await list("/v1/tools");
    const policies = await list("/v1/policies");
    if (!tools || !policies) add("rules", "fail", "could not read the mock's tools and policies");
    else {
      const ours = tools.map((t) => String(t.tool_ref)).filter((r) => r.startsWith(FERNHILL_TOOL_PREFIX));
      const effectiveMode = (ref: string): Mode | undefined => {
        let tightest: Mode | undefined;
        for (const p of policies) {
          if (p.kind !== "tool_invocation" || p.state !== "published" || !p.subjects?.some((s: any) => s.type === "role" && s.id === "everyone")) continue;
          const covers = p.targets?.tools === "all" || (Array.isArray(p.targets?.tools) && p.targets.tools.includes(ref));
          if (!covers) continue;
          tightest = tighterOf(tightest, modeOf(p.config?.mode));
        }
        return tightest;
      };
      if (!installed) {
        const ruled = policies.filter((p) => Array.isArray(p.targets?.tools) && p.targets.tools.some((r: string) => r.startsWith(FERNHILL_TOOL_PREFIX)));
        if (ours.length || ruled.length) add("rules", "fail", `${ours.length} Fernhill tool(s) and ${ruled.length} rule(s) exist on a pre-install tree. Restart the mock with: bun run reset`);
        else add("rules", "pass", "none, as expected before the install");
      } else {
        let plan: { policies: Array<{ tool: string; mode: string }> };
        try {
          plan = JSON.parse(readFileSync(join(cfg.root, RULES_PLAN), "utf8"));
        } catch (error) {
          plan = { policies: [] };
          add("rules", "fail", `cannot read ${RULES_PLAN}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (plan.policies.length) {
          const problems: string[] = [];
          const expected = new Set(plan.policies.map((p) => p.tool));
          for (const { tool, mode } of plan.policies) {
            const short = tool.replace(FERNHILL_TOOL_PREFIX, "");
            if (!ours.includes(tool)) problems.push(`${short}: tool not registered`);
            else {
              const found = effectiveMode(tool);
              if (found !== mode) problems.push(`${short}: expected ${mode}, found ${found ?? "no rule"}`);
            }
          }
          for (const ref of ours) if (!expected.has(ref)) problems.push(`${ref.replace(FERNHILL_TOOL_PREFIX, "")}: registered but not in the plan`);
          if (problems.length) add("rules", "fail", `${problems.join("; ")}. Approve ${RULES_PLAN} (see docs/presenter-guide.md, "Opening the proposal by hand").`);
          else add("rules", "pass", `${plan.policies.length} tools registered, every mode matches ${RULES_PLAN}`);
        }
      }
    }
  }

  // Files.
  const credentialFile = join(cfg.root, CREDENTIAL_PATH);
  if (!existsSync(credentialFile)) add("credentials", "fail", `${CREDENTIAL_PATH} is missing. The mock writes it on start: bun run demo`);
  else {
    try {
      const credential = JSON.parse(readFileSync(credentialFile, "utf8"));
      if (typeof credential.client_id !== "string") add("credentials", "fail", `${CREDENTIAL_PATH} has no client_id`);
      else if (credential.token_endpoint !== `${cfg.mockUrl}/oauth/token`) add("credentials", "fail", `${CREDENTIAL_PATH} points at ${String(credential.token_endpoint)}, not this mock (${cfg.mockUrl}/oauth/token). Restart with: bun run demo`);
      else add("credentials", "pass", CREDENTIAL_PATH);
    } catch {
      add("credentials", "fail", `${CREDENTIAL_PATH} is not valid JSON`);
    }
  }
  const envFile = join(cfg.root, ".env.local");
  if (!existsSync(envFile)) add(".env.local", "fail", ".env.local is missing. `bun run noblecloak` writes it, or create it with the three NC values");
  else {
    const have = parseEnvFile(readFileSync(envFile, "utf8"));
    const wrong = Object.entries(ncEnv(cfg)).filter(([key, want]) => have[key] !== want).map(([key, want]) => `${key} is ${have[key] === undefined ? "missing" : `"${have[key]}"`}, expected "${want}"`);
    if (wrong.length) add(".env.local", "fail", wrong.join("; "));
    else add(".env.local", "pass", "NC_BASE_URL, NOBLECLOAK_SP_CREDENTIALS and NC_EXPECTED_PRINCIPAL are right");
  }

  // The client pin: the installed top-level @noblecloak/client satisfies what the installed @noblecloak/langgraph
  // declares: an exact version (0.5.1 and older) or a range like `>=0.13.1 <0.15.0` (0.5.2).
  try {
    const pkg = JSON.parse(readFileSync(join(cfg.root, "package.json"), "utf8"));
    const override: string | undefined = pkg.overrides?.["@noblecloak/client"];
    const read = (rel: string) => {
      const file = join(cfg.root, "node_modules", rel, "package.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    };
    const declared: string | undefined = read("@noblecloak/langgraph")?.dependencies?.["@noblecloak/client"];
    const installed: string | undefined = read("@noblecloak/client")?.version;
    if (declared === undefined) add("client pin", "warn", "@noblecloak/langgraph is not installed here: run bun install");
    else if (installed === undefined || !satisfiesDeclared(installed, declared)) add("client pin", "fail", `@noblecloak/langgraph asks for @noblecloak/client ${declared}, but ${installed ?? "none"} is installed: run bun install`);
    else if (override) add("client pin", "warn", `@noblecloak/client ${installed} satisfies what langgraph asks for, so the package.json override (${override}) is no longer needed; remove it`);
    else add("client pin", "pass", `@noblecloak/client ${installed} satisfies ${declared}, which @noblecloak/langgraph asks for`);
  } catch (error) {
    add("client pin", "warn", `could not check: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Warnings that do not block the demo.
  if ((deps.pathUnderBianoble ?? underBianoble)(cfg.root, cfg.home)) add("location", "warn", `${cfg.root} is under ~/bianoble, so the parent CLAUDE.md loads into a Claude session started here. Run the install demo from a clone outside it.`);
  else add("location", "pass", "outside ~/bianoble");
  const pluginList = join(cfg.home, ".claude/plugins/installed_plugins.json");
  if (!existsSync(pluginList)) add("plugin", "pass", "cannot tell whether the NobleCloak plugin is installed (no plugin list on this machine); not checked");
  else {
    try {
      const names = Object.keys(JSON.parse(readFileSync(pluginList, "utf8")).plugins ?? {});
      if (names.some((n) => n.toLowerCase().includes("noblecloak"))) add("plugin", "pass", "the NobleCloak plugin is installed");
      else add("plugin", "warn", "the NobleCloak plugin is not in ~/.claude/plugins/installed_plugins.json. The live install needs it (or --plugin-dir).");
    } catch {
      add("plugin", "pass", "cannot read the plugin list; not checked");
    }
  }
  return { checks, ok: !checks.some((c) => c.status === "fail") };
}

if (process.argv[1]?.endsWith("scripts/preflight.ts")) {
  const cfg = entryConfig();
  runPreflight(cfg).then((report) => {
    const label = { pass: "PASS", fail: "FAIL", warn: "WARN" } as const;
    for (const c of report.checks) console.log(`${label[c.status]}  ${c.name}: ${c.detail}`);
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.name);
    if (report.ok) console.log("\nREADY: safe to begin.");
    else console.log(`\nNOT READY. Failed: ${failed.join(", ")}`);
    process.exit(report.ok ? 0 : 1);
  });
}
