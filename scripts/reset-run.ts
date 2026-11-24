// `bun run reset`: between two runs of the demo. Clears the run and its checkpoints, and clears the mock's pending
// approvals by restarting the mock and the worker together (the mock keeps all state in memory).
//
// A mock restart also wipes the rules, the registered tools and the agent. Say so, and say how to bring the rules back.
// The restart is done by `bun run demo`, which owns the processes. When it is not running, this script does not touch
// any process: it clears the run and prints what to restart.
//
// `bun run reset --rules [--no-approve] [--plugin <dir>]` (or NOBLECLOAK_PLUGIN_DIR) also puts the rules back on an installed tree:
// it opens demo/rules.plan.json with the skill's propose.mjs and approves it the way the run page's button does.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RULES_PLAN, WORKER_FILE, entryConfig, refuseInDeployment, type DemoConfig } from "./demo-config";
import { liveLauncher, waitFor } from "./demo-state";

type Io = { log: (message: string) => void };
export type ResetRunResult = { ok: boolean; restarted: boolean; clearedVia: "app" | "files" | "failed"; rules?: "approved" | "opened" | "failed" };
export type ResetOptions = {
  /** Open and approve demo/rules.plan.json again after the restart (the command in docs/presenter-guide.md, "Opening the proposal by hand"). */
  rules?: boolean;
  /** The Claude plugin's directory, which holds the setup skill's propose.mjs. */
  pluginDir?: string;
  /** With rules: false opens the proposal but leaves the approval to the administrator on the run page. Default true. */
  approve?: boolean;
};

const PROPOSE = "setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs";

/**
 * The NobleCloak plugin's directory as Claude Code recorded it when the plugin was installed from the marketplace
 * (`/plugin install noblecloak@noblecloak`): ~/.claude/plugins/installed_plugins.json lists each plugin's installPath
 * (a folder under ~/.claude/plugins/cache/). Returns it only if it holds the setup skill's propose.mjs.
 */
export function findPluginDir(home: string): string | undefined {
  try {
    const listed = (JSON.parse(readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8")) as { plugins?: Record<string, Array<{ installPath?: string }>> }).plugins ?? {};
    for (const [key, installs] of Object.entries(listed)) {
      if (!/^noblecloak@/.test(key)) continue;
      for (const { installPath } of installs) if (installPath && existsSync(join(installPath, PROPOSE))) return installPath;
    }
  } catch { /* no list, or not JSON: the caller says how to name the directory */ }
  return undefined;
}

/**
 * The tested stage fallback: the skill's propose.mjs run directly with a person's token from the mock, then the
 * approval the run page's "Approve rules" button sends. Needs the mock fresh (agent.json id null) and the app up.
 */
export async function reopenRules(cfg: DemoConfig, pluginDir: string | undefined, io: Io, approve = true): Promise<boolean> {
  const dir = pluginDir ?? findPluginDir(cfg.home);
  const propose = dir ? join(dir, PROPOSE) : "";
  if (!dir || !existsSync(propose)) {
    io.log(`RULES NOT RESTORED: ${dir ? `${propose} does not exist` : "the NobleCloak plugin was not found in ~/.claude/plugins/installed_plugins.json"}. Install it (/plugin marketplace add NobleCloak/noblecloak-claude-plugin, then /plugin install noblecloak@noblecloak), or pass --plugin <dir> / set NOBLECLOAK_PLUGIN_DIR to its directory.`);
    return false;
  }
  try {
    const { creator_user: token } = (await (await fetch(`${cfg.mockUrl}/__mock/tokens`)).json()) as { creator_user: string };
    execFileSync("node", [propose, "--plan", RULES_PLAN], { cwd: cfg.root, env: { ...process.env, NC_BASE_URL: cfg.mockUrl, NC_PROPOSER_TOKEN: token }, stdio: "pipe" });
    const proposal = await waitFor<{ id: string; actionDigest: string }>("the rules proposal on the run page", async () => {
      const body = (await (await fetch(`${cfg.appUrl}/api/proposal`)).json().catch(() => null)) as { proposal?: { id: string; actionDigest: string; state: string } } | null;
      if (body?.proposal?.state === "pending") return body.proposal;
      return null;
    }, 20_000, 500);
    if (!approve) {
      io.log(`Rules opened from ${RULES_PLAN}; approve them on the run page, ${cfg.appUrl}/people/onboarding/maya-torres.`);
      return true;
    }
    const res = await fetch(`${cfg.appUrl}/api/proposal/${proposal.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedActionDigest: proposal.actionDigest }) });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (!res.ok || !out?.ok) throw new Error(out?.message ?? `HTTP ${res.status}`);
    io.log(`Rules opened from ${RULES_PLAN} and approved.`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}${"stderr" in error ? ` ${String((error as { stderr?: unknown }).stderr ?? "").slice(0, 300)}` : ""}` : String(error);
    io.log(`RULES NOT RESTORED: ${detail.trim()}`);
    return false;
  }
}

/** An install records the mock's agent id here; a new mock rejects it (`unknown_agent`) until it is null again. */
function forgetAgentId(root: string): boolean {
  const file = join(root, "src/noblecloak/agent.json");
  if (!existsSync(file)) return false;
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (json.id === null || json.id === undefined) return false;
  writeFileSync(file, `${JSON.stringify({ ...json, id: null }, null, 2)}\n`);
  return true;
}

export async function resetRunCommand(cfg: DemoConfig, io: Io = { log: console.log }, options: ResetOptions = {}): Promise<ResetRunResult> {
  // 1. The run and its checkpoints. Through the app when it is up (the same call as the hidden control on the run page).
  let clearedVia: ResetRunResult["clearedVia"] = "failed";
  try {
    const res = await fetch(`${cfg.appUrl}/api/run`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { state?: string } | null;
    if (res.ok && body?.state === "idle") clearedVia = "app";
    else io.log(`The app answered the reset with HTTP ${res.status}${body?.state ? ` and state ${body.state}` : ""}.`);
  } catch {
    // The app is not running, so nothing holds the files open.
    for (const name of existsSync(cfg.dataDir) ? readdirSync(cfg.dataDir) : []) {
      if (/^(run|checkpoints)\.sqlite/.test(name)) rmSync(join(cfg.dataDir, name), { force: true });
    }
    clearedVia = "files";
  }
  if (clearedVia === "failed") {
    io.log("FAILED: the run was not cleared.");
    return { ok: false, restarted: false, clearedVia };
  }
  io.log(clearedVia === "app" ? "Run and checkpoints cleared (the app reports idle)." : "Run and checkpoints cleared from .data/ (the app is not running).");

  // 2. The mock and the worker, if the demo launcher owns them.
  const owner = liveLauncher(cfg.stateFile);
  let restarted = false;
  let rules: ResetRunResult["rules"];
  if (owner?.mode === "running") {
    // Correct agent.json BEFORE the restart: the new worker starts with the files as they are then.
    if (forgetAgentId(cfg.root)) io.log("Set src/noblecloak/agent.json id back to null (the old mock's agent id is invalid on the new one).");
    io.log("Restarting the mock and the worker together.");
    process.kill(owner.pid, "SIGUSR1");
    await waitFor("the mock and worker to come back", () => {
      const s = liveLauncher(cfg.stateFile);
      return s && s.mode === "running" && s.generation > owner.generation;
    }, 90_000);
    restarted = true;
    io.log("Mock restarted: every pending approval is gone.");
    const installed = existsSync(join(cfg.root, WORKER_FILE));
    if (installed && options.rules) {
      const approve = options.approve ?? true;
      rules = (await reopenRules(cfg, options.pluginDir, io, approve)) ? (approve ? "approved" : "opened") : "failed";
    }
    if (installed && rules !== "approved" && rules !== "opened") {
      io.log("NOTE: the rules, the registered tools and the agent were wiped with the mock. Until they are approved again every call shows \"Not allowed\".");
      io.log("To put the rules back without reinstalling, with the mock fresh and <plugin> the plugin's directory (docs/presenter-guide.md, \"Opening the proposal by hand\"):");
      io.log(`  NC_BASE_URL=${cfg.mockUrl} NC_PROPOSER_TOKEN="$(curl -s ${cfg.mockUrl}/__mock/tokens | node -pe 'JSON.parse(require("fs").readFileSync(0)).creator_user')" \\`);
      io.log("  node <plugin>/setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs --plan demo/rules.plan.json");
      io.log(`Then approve on the run page, ${cfg.appUrl}/people/onboarding/maya-torres. Check with: bun run preflight`);
    } else if (!installed) {
      io.log("NobleCloak is not installed, so there were no rules to lose.");
    }
  } else {
    io.log(owner ? `The demo launcher (pid ${owner.pid}) is ${owner.mode}, not running, so nothing was restarted.` : "`bun run demo` is not running here, so the mock and the worker were NOT restarted and pending approvals are still there.");
    io.log(`Restart them yourself, together: the mock (bun run noblecloak) and then the worker (bun run worker)${owner ? "" : ", or stop everything and use bun run demo"}. A worker left across a mock restart holds a dead token and stalls.`);
    io.log("A mock restart also wipes the rules; see docs/presenter-guide.md (Opening the proposal by hand) for putting them back.");
    if (options.rules) io.log("--rules was ignored: it needs the mock restarted by `bun run demo`, so the new mock is empty.");
  }
  return { ok: rules !== "failed", restarted, clearedVia, ...(rules ? { rules } : {}) };
}

if (process.argv[1]?.endsWith("scripts/reset-run.ts")) {
  refuseInDeployment("bun run reset");
  const args = process.argv.slice(2);
  const at = args.indexOf("--plugin");
  const options: ResetOptions = { rules: args.includes("--rules"), approve: !args.includes("--no-approve"), pluginDir: (at >= 0 ? args[at + 1] : undefined) ?? process.env.NOBLECLOAK_PLUGIN_DIR };
  resetRunCommand(entryConfig(), { log: console.log }, options).then(
    (r) => process.exit(r.ok ? 0 : 1),
    (error) => {
      console.error(`reset failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
