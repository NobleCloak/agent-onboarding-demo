// `bun run reset:full`: return this checkout to the pre-install state, so the install can be shown again from scratch.
//
// It puts the checkout on the base branch (scripts/demo-config.ts: BASE_BRANCH), removes src/noblecloak/, restores the
// files the install edits, and clears .data/. It REFUSES, changing nothing, if the tree has any change outside the
// install's known paths, and lists them. It never deletes a file outside those paths, never forces a branch away from
// work it cannot name, and never pushes.
//
// Order of work: every refusal is decided first (including whether git can switch to the base branch here); only then
// is the demo paused, a backup of anything about to be discarded written to .reset-backups/, the branch switched, and
// only after the switch the install removed. If anything fails after the pause, the demo is resumed.
//
// Running processes: if `bun run demo` owns them, they are paused for the file work and started again afterwards on a
// fresh mock (so the rules, the credential and any pending approval are new). Anything else listening on the app or
// mock port is not ours to stop, so the reset refuses until it is gone.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKUP_DIR, INSTALL_EDIT_MARKER, INSTALL_PATHS, entryConfig, refuseInDeployment, type DemoConfig } from "./demo-config";
import { liveLauncher, portInUse, waitFor, type LauncherState } from "./demo-state";

type Io = { log: (message: string) => void };
export type ResetFullResult = { ok: true; left: string; removed: string[]; backup?: string } | { ok: false; offending: string[]; reasons: string[] };

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const isInstallPath = (path: string): boolean =>
  (INSTALL_PATHS.files as readonly string[]).includes(path) || INSTALL_PATHS.dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));

/** Every path git sees as changed (staged, unstaged or untracked, ignored files excluded) that is not an install path. */
export function pathsOutsideInstall(root: string): string[] {
  const entries = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean);
  const outside = new Set<string>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const code = entry.slice(0, 2);
    const paths = [entry.slice(3)];
    if (code[0] === "R" || code[0] === "C") paths.push(entries[(i += 1)] ?? ""); // a rename lists its source next
    for (const path of paths) if (path && !isInstallPath(path)) outside.add(path);
  }
  return [...outside];
}

const branchExists = (root: string, name: string): boolean => {
  try {
    git(root, "rev-parse", "--verify", "--quiet", `${name}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

/**
 * Tracked install files whose uncommitted change adds no line naming NobleCloak: hand edits, not the install's.
 * (Files inside the install directory are the install's own, whatever they hold, and are backed up instead.)
 */
export function unexpectedEdits(root: string): string[] {
  const changed = git(root, "diff", "HEAD", "--name-only", "-z", "--", ...INSTALL_PATHS.files).split("\0").filter(Boolean);
  return changed.filter((file) => {
    const added = git(root, "diff", "HEAD", "-U0", "--", file).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    return !added.some((l) => INSTALL_EDIT_MARKER.test(l));
  });
}

/** Another worktree that has `branch` checked out, if any: git cannot switch to it here. */
export function checkedOutElsewhere(root: string, branch: string): string | null {
  const here = realpathSync(root);
  let path = "";
  for (const line of git(root, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    if (line === `branch refs/heads/${branch}` && realpathSync(path) !== here) return path;
  }
  return null;
}

/** Save what is about to be discarded: a patch of every tracked change to install paths, and untracked files of the install dir. */
function backUp(root: string): string | undefined {
  const known = [...INSTALL_PATHS.dirs, ...INSTALL_PATHS.files];
  const patch = git(root, "diff", "HEAD", "--binary", "--", ...known);
  const untracked = INSTALL_PATHS.dirs.flatMap((d) => git(root, "ls-files", "-z", "--others", "--exclude-standard", "--", d).split("\0").filter(Boolean));
  if (!patch && !untracked.length) return undefined;
  const dir = join(root, BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  if (patch) writeFileSync(join(dir, "tracked.patch"), patch);
  for (const file of untracked) {
    mkdirSync(dirname(join(dir, "untracked", file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, "untracked", file));
  }
  return dir;
}

async function waitForMode(file: string, want: LauncherState["mode"], afterGeneration: number): Promise<LauncherState> {
  return waitFor<LauncherState>(`the launcher to be ${want}`, () => {
    const s = liveLauncher(file);
    return s && s.mode === want && s.generation > afterGeneration ? s : null;
  }, want === "running" ? 180_000 : 60_000);
}

export async function resetFull(cfg: DemoConfig, io: Io = { log: console.log }): Promise<ResetFullResult> {
  const { root, baseBranch } = cfg;
  const reasons: string[] = [];

  // 1. Every refusal is decided before anything changes (or is paused).
  let offending: string[] = [];
  let left = "";
  let isRepo = true;
  try {
    git(root, "rev-parse", "--git-dir");
    left = git(root, "branch", "--show-current").trim() || "(detached HEAD)";
    offending = pathsOutsideInstall(root);
  } catch {
    isRepo = false;
    reasons.push(`${root} is not a git checkout.`);
  }
  if (offending.length) {
    reasons.push(`The tree has changes outside the install's known paths (${[...INSTALL_PATHS.dirs, ...INSTALL_PATHS.files].join(", ")}). Commit, stash or remove these yourself, then run it again:\n  ${offending.join("\n  ")}`);
  }
  if (isRepo) {
    if (!branchExists(root, baseBranch)) reasons.push(`The base branch "${baseBranch}" does not exist here. Set BASE_BRANCH in scripts/demo-config.ts.`);
    else if (left !== baseBranch) {
      const elsewhere = checkedOutElsewhere(root, baseBranch);
      if (elsewhere) reasons.push(`The base branch "${baseBranch}" is checked out in another worktree (${elsewhere}), so git cannot switch to it here. Run reset:full from that worktree, or free the branch there.`);
    }
    const edits = unexpectedEdits(root);
    if (edits.length) reasons.push(`These install files have uncommitted edits that are not the install's (none of the added lines names NobleCloak). Commit or revert them yourself, then run it again:\n  ${edits.join("\n  ")}`);
  }
  try {
    if (existsSync(cfg.dataDir) && lstatSync(cfg.dataDir).isSymbolicLink()) reasons.push(`${cfg.dataDir} is a symlink. It will not be cleared, because that would delete the target's contents. Remove the link yourself.`);
  } catch { /* unreadable: the clear step will report it */ }
  const owner = liveLauncher(cfg.stateFile);
  if (owner && owner.mode !== "running" && owner.mode !== "paused") reasons.push(`The demo launcher (pid ${owner.pid}) is ${owner.mode}. Wait for it to finish, then run this again.`);
  if (!owner) {
    for (const [what, port] of [["app", cfg.appPort], ["NobleCloak mock", cfg.mockPort]] as const) {
      if (await portInUse(port)) reasons.push(`Port ${port} (${what}) is in use by a process \`bun run demo\` did not start. Stop it first: clearing .data/ under a running app would corrupt it, and this script does not stop processes it did not start.`);
    }
  }
  if (reasons.length) {
    for (const reason of reasons) io.log(`REFUSED: ${reason}`);
    io.log("Nothing was changed.");
    return { ok: false, offending, reasons };
  }

  // 2. Stop the demo's processes (only if the demo launcher owns them). A launcher already paused (an earlier reset:full
  //    that died) is used as it is: toggling it again would start it.
  let paused = false;
  if (owner?.mode === "running") {
    io.log(`Pausing the demo (launcher pid ${owner.pid}).`);
    process.kill(owner.pid, "SIGUSR2");
    await waitForMode(cfg.stateFile, "paused", owner.generation);
    paused = true;
  } else if (owner?.mode === "paused") {
    io.log(`The demo launcher (pid ${owner.pid}) is already paused, probably by an earlier reset:full that stopped. Continuing.`);
    paused = true;
  }

  const resume = async () => {
    if (!paused) return;
    const now = liveLauncher(cfg.stateFile);
    if (!now) return;
    io.log("Starting the demo again on a fresh mock.");
    process.kill(now.pid, "SIGUSR2");
    await waitForMode(cfg.stateFile, "running", now.generation);
  };

  // 3. Files: back up, switch branch FIRST, and only then remove the install.
  const removed: string[] = [];
  let backup: string | undefined;
  try {
    const known = [...INSTALL_PATHS.dirs, ...INSTALL_PATHS.files];
    backup = backUp(root);
    if (backup) io.log(`Saved what would be discarded to ${backup}`);
    if (left !== baseBranch) {
      // Everything this discards was refused or backed up above; -f lets the switch go through over the install's edits.
      git(root, "checkout", "-q", "-f", baseBranch);
      io.log(`Switched from ${left} to ${baseBranch}. ${left} keeps its commits.`);
    } else {
      git(root, "reset", "-q", "--", ...known);
      const tracked = git(root, "ls-files", "-z", "--", ...known).split("\0").filter(Boolean);
      if (tracked.length) git(root, "checkout", "--", ...tracked);
    }
    for (const dir of INSTALL_PATHS.dirs) {
      if (existsSync(join(root, dir))) {
        rmSync(join(root, dir), { recursive: true, force: true });
        removed.push(`${dir}/`);
      }
    }
    if (existsSync(cfg.dataDir)) {
      for (const name of readdirSync(cfg.dataDir)) rmSync(join(cfg.dataDir, name), { recursive: true, force: true });
      rmSync(cfg.dataDir, { recursive: true, force: true });
      removed.push(".data/");
    }
  } catch (error) {
    io.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    io.log(`The checkout may be partly reset; it is on ${git(root, "branch", "--show-current").trim() || "(detached HEAD)"}. ${backup ? `A backup of the install's edits is at ${backup}.` : ""}`);
    await resume().catch((e) => io.log(`Could not start the demo again: ${e instanceof Error ? e.message : String(e)}`));
    return { ok: false, offending: [], reasons: [error instanceof Error ? error.message : String(error)] };
  }

  // 4. Bring the demo back on a fresh mock.
  await resume();

  io.log(`Reset to ${baseBranch}: NobleCloak is not installed, .data/ is cleared${paused ? ", and the mock, app and worker were restarted (every rule, credential and pending approval is new)" : ""}.`);
  io.log("Left alone: .env.local, node_modules, and anything git-ignored outside the install.");
  if (!paused) io.log("Start the demo with: bun run demo");
  return { ok: true, left, removed, ...(backup ? { backup } : {}) };
}

if (process.argv[1]?.endsWith("scripts/reset-full.ts")) {
  refuseInDeployment("bun run reset:full");
  resetFull(entryConfig(), { log: console.log }).then(
    (r) => process.exit(r.ok ? 0 : 1),
    (error) => {
      console.error(`reset:full failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
