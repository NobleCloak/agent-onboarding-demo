// `bun run demo:new [name]`: a brand-new copy of the demo for one session, instead of resetting a long-lived checkout.
//
// It clones BASE_BRANCH (scripts/demo-config.ts) from this checkout's `origin` into ~/demos/fernhill-<name or date>,
// runs `bun install` there, and prints what to run next. It copies nothing from this checkout: no .env.local, no .data/,
// no node_modules, no credentials. `bun run demo` creates the git-ignored files a fresh clone needs (.env.local, and the
// mock writes .data/noblecloak-sp.credentials.json). It refuses if the target exists or is under ~/bianoble, where the
// parent CLAUDE.md would load into the Claude Code session. FERNHILL_DEMOS_DIR replaces ~/demos (tests).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { BASE_BRANCH, GOVERNED_BRANCH, refuseInDeployment, requireRoot } from "./demo-config";

export type Runner = (cmd: string, args: string[], cwd: string) => void;
export type NewOptions = {
  baseBranch?: string;
  governedBranch?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  run?: Runner;
  log?: (message: string) => void;
};
export type NewResult = { ok: true; target: string } | { ok: false; reasons: string[] };

const defaultRun: Runner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${String(r.status)}`);
};

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

/** realpath of the nearest existing ancestor, then the rest appended: a path that does not exist yet still resolves symlinks above it. */
function resolveThrough(path: string): string {
  const abs = resolve(path);
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/**
 * True for a remote URL that carries credentials: a username or password in an http(s) URL, or a password in an ssh://
 * URL (`ssh://git@host/...` is an ordinary username and is fine). Such a URL would be printed and copied into the new
 * clone's .git/config.
 */
export function isCredentialedUrl(remote: string): boolean {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return false; // a path or scp-style address (git@host:org/repo) has no embedded password
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.username !== "" || url.password !== "";
  return url.password !== "";
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateName = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export async function demoNew(sourceRoot: string, name: string | undefined, opts: NewOptions = {}): Promise<NewResult> {
  const log = opts.log ?? console.log;
  const baseBranch = opts.baseBranch ?? BASE_BRANCH;
  const governedBranch = opts.governedBranch ?? GOVERNED_BRANCH;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRun;
  const reasons: string[] = [];

  const folder = name === undefined ? dateName(opts.now ?? new Date()) : name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(folder) || folder.includes("..")) reasons.push(`"${folder}" is not a plain folder name (letters, digits, dot, dash, underscore; no slashes).`);
  const demosDir = env.FERNHILL_DEMOS_DIR ? resolve(env.FERNHILL_DEMOS_DIR) : join(home, "demos");
  const target = join(demosDir, `fernhill-${folder}`);

  const origin = git(sourceRoot, "remote", "get-url", "origin");
  const remote = origin.status === 0 ? origin.stdout.trim() : "";
  if (!remote) reasons.push(`${sourceRoot} has no \`origin\` remote to clone from.`);
  else if (isCredentialedUrl(remote)) reasons.push("The origin remote URL has a username or password in it. It would be printed here and copied into the new clone's .git/config, so this command will not use it. Remove the credentials from the remote (git remote set-url origin <url without credentials>) and use a credential helper (e.g. gh auth setup-git, or the macOS keychain helper) or an SSH remote instead.");

  if (!reasons.length) {
    try {
      lstatSync(target);
      reasons.push(`${target} already exists. Pick another name, or remove it yourself; this command never overwrites.`);
    } catch { /* free */ }
    const guarded = [join(home, "bianoble"), (() => { try { return join(realpathSync(home), "bianoble"); } catch { return join(home, "bianoble"); } })()];
    const where = resolveThrough(target);
    if (guarded.some((g) => where === g || where.startsWith(g + sep))) reasons.push(`${target} is under ~/bianoble, where the parent CLAUDE.md would load into the Claude Code session. Choose a folder outside it.`);
  }
  if (reasons.length) {
    for (const r of reasons) log(`REFUSED: ${r}`);
    return { ok: false, reasons };
  }

  mkdirSync(demosDir, { recursive: true });
  log(`Cloning ${baseBranch} from ${remote} into ${target}`);
  const clone = git(demosDir, "clone", "--branch", baseBranch, remote, target);
  if (clone.status !== 0) {
    rmSync(target, { recursive: true, force: true }); // it did not exist before this command, so nothing of anyone's is lost
    const why = `git clone failed: ${clone.stderr.trim().split("\n").pop() ?? ""}`;
    log(`FAILED: ${why}`);
    return { ok: false, reasons: [why] };
  }
  if (git(target, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${governedBranch}`).status !== 0) {
    log(`WARNING: ${governedBranch} is not on origin, so this copy cannot cut to the governed fallback. Push it from the source checkout first.`);
  }

  try {
    log("Running bun install (from the public npm registry; no GitHub Packages token is needed).");
    run("bun", ["install"], target);
  } catch (error) {
    const why = `bun install failed: ${error instanceof Error ? error.message : String(error)}. The copy is at ${target}; fix the cause and run bun install there.`;
    log(`FAILED: ${why}`);
    return { ok: false, reasons: [why] };
  }

  log("");
  log(`Ready: ${target}  (branch ${baseBranch}; nothing copied from ${sourceRoot})`);
  log("Next:");
  log(`  cd ${target}`);
  log("  bun run demo        # terminal 1: creates .env.local, the credential and .data/, starts the mock and the app");
  log("  bun run preflight   # terminal 2: READY means safe to begin");
  log(`  claude              # terminal 2 or 3: open Claude Code in ${target}, then give it the install prompt`);
  log(`Fallback: git checkout ${governedBranch} in the running copy; the launcher starts the worker by itself (see docs/presenter-guide.md, "Demo day").`);
  return { ok: true, target };
}

if (process.argv[1]?.endsWith("scripts/demo-new.ts")) {
  refuseInDeployment("bun run demo:new");
  let root: string;
  try {
    root = requireRoot();
  } catch (error) {
    console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  demoNew(root, process.argv[2]).then((r) => process.exit(r.ok ? 0 : 1));
}
