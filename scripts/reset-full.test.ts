import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetFull } from "./reset-full";
import { BASE, configFor, git, makeRepo, put, tempDir } from "./test-support/fixtures";

const quiet = { log: () => undefined };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const state = (root: string) => ({ branch: git(root, "branch", "--show-current").trim(), status: git(root, "status", "--porcelain", "--untracked-files=all") });

describe("reset:full", () => {
  it("refuses when the working tree has changes outside the install's known paths, and changes nothing", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    put(root, "README.md", "edited by hand\n"); // tracked, not an install path
    put(root, "notes.txt", "mine\n"); // untracked, not an install path
    put(root, "src/agent/scratch.ts", "x\n"); // untracked beside an install file, still not an install path
    put(root, "src/noblecloak/agent.json", '{"id":"agt_1"}\n'); // an install path: not a reason to refuse
    mkdirSync(join(root, ".data"));
    writeFileSync(join(root, ".data/run.sqlite"), "data");
    const before = state(root);

    const out = await resetFull(await configFor(root), quiet);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.offending.sort()).toEqual(["README.md", "notes.txt", "src/agent/scratch.ts"]);
    expect(state(root)).toEqual(before);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("edited by hand\n");
    expect(readFileSync(join(root, "src/noblecloak/agent.json"), "utf8")).toBe('{"id":"agt_1"}\n');
    expect(existsSync(join(root, ".data/run.sqlite"))).toBe(true);
  });

  it("returns an installed, edited tree to the base branch with the install gone and .data cleared", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    put(root, "src/noblecloak/agent.json", '{"id":"agt_1"}\n'); // propose.mjs wrote an agent id
    put(root, "src/noblecloak/extra.ts", "// untracked inside the install dir\n");
    put(root, "src/agent/start.ts", "import './noblecloak/half-edited';\n");
    put(root, ".env.local", "NC_BASE_URL=http://127.0.0.1:1\n"); // ignored: must survive
    mkdirSync(join(root, ".data"));
    writeFileSync(join(root, ".data/run.sqlite"), "data");

    const out = await resetFull(await configFor(root), quiet);

    expect(out.ok).toBe(true);
    expect(git(root, "branch", "--show-current").trim()).toBe(BASE);
    expect(existsSync(join(root, "src/noblecloak"))).toBe(false);
    expect(readFileSync(join(root, "src/agent/start.ts"), "utf8")).toBe("export const build = 'plain';\n");
    expect(readFileSync(join(root, ".env.example"), "utf8")).toBe("NC_BASE_URL=\n");
    expect(existsSync(join(root, ".data/run.sqlite"))).toBe(false);
    expect(existsSync(join(root, ".env.local"))).toBe(true);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("also undoes an install copied onto the base branch by checkout (staged, never committed)", async () => {
    const root = makeRepo();
    git(root, "checkout", "governed", "--", "src/noblecloak", "src/agent", ".env.example");
    expect(git(root, "status", "--porcelain")).not.toBe("");

    const out = await resetFull(await configFor(root), quiet);

    expect(out.ok).toBe(true);
    expect(state(root)).toEqual({ branch: BASE, status: "" });
    expect(existsSync(join(root, "src/noblecloak"))).toBe(false);
  });

  it("does nothing but clear .data on a tree that is already pre-install", async () => {
    const root = makeRepo();
    mkdirSync(join(root, ".data"));
    writeFileSync(join(root, ".data/checkpoints.sqlite"), "x");
    const out = await resetFull(await configFor(root), quiet);
    expect(out.ok).toBe(true);
    expect(existsSync(join(root, ".data/checkpoints.sqlite"))).toBe(false);
    expect(state(root)).toEqual({ branch: BASE, status: "" });
  });

  it("refuses, changing nothing, when a port is held by a process the demo did not start, and leaves that process running", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    const cfg = await configFor(root);
    const stranger = net.createServer();
    await new Promise<void>((resolve) => stranger.listen(cfg.appPort, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => stranger.close(() => resolve())));
    const before = state(root);

    const out = await resetFull(cfg, quiet);

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toContain(String(cfg.appPort));
    expect(state(root)).toEqual(before);
    expect(stranger.listening).toBe(true);
  });

  it("refuses when the base branch does not exist", async () => {
    const root = makeRepo();
    const cfg = { ...(await configFor(root)), baseBranch: "no-such-branch" };
    const out = await resetFull(cfg, quiet);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toContain("no-such-branch");
  });
  it("refuses, before changing anything, when git cannot switch to the base branch because another worktree has it", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    const other = join(tempDir(), "wt");
    git(root, "worktree", "add", other, BASE);
    mkdirSync(join(root, ".data"));
    writeFileSync(join(root, ".data/run.sqlite"), "data");
    const before = state(root);

    const out = await resetFull(await configFor(root), quiet);

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toMatch(/checked out in another worktree/);
    expect(state(root)).toEqual(before);
    expect(existsSync(join(root, "src/noblecloak/worker.ts"))).toBe(true);
    expect(existsSync(join(root, ".data/run.sqlite"))).toBe(true);
  });

  it("refuses, listing the files, when an install file has an uncommitted edit that is not the install's", async () => {
    const root = makeRepo();
    put(root, "src/agent/start.ts", "export const build = 'my own tweak';\n");
    put(root, ".env.example", "NC_BASE_URL=\nSOMETHING_ELSE=\n");
    const before = state(root);
    const out = await resetFull(await configFor(root), quiet);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toMatch(/\.env\.example[\s\S]*src\/agent\/start\.ts/);
    expect(state(root)).toEqual(before);
    expect(readFileSync(join(root, "src/agent/start.ts"), "utf8")).toBe("export const build = 'my own tweak';\n");
  });

  it("saves a patch of the install's edits and a copy of untracked install files before discarding them, and says where", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    put(root, "src/agent/start.ts", "import './noblecloak/governance';\nexport const build = 'tuned on stage';\n// NobleCloak edit\n");
    put(root, "src/noblecloak/extra.ts", "// not tracked\n");
    const lines: string[] = [];

    const out = await resetFull(await configFor(root), { log: (m) => lines.push(m) });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.backup).toBeDefined();
    expect(lines.join("\n")).toContain(out.backup!);
    expect(readFileSync(join(out.backup!, "tracked.patch"), "utf8")).toContain("tuned on stage");
    expect(readFileSync(join(out.backup!, "untracked/src/noblecloak/extra.ts"), "utf8")).toBe("// not tracked\n");
    expect(out.backup!.startsWith(join(root, ".reset-backups"))).toBe(true);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe(""); // the backup folder is git-ignored
  });

  it("writes no backup when there is nothing to discard", async () => {
    const root = makeRepo();
    const out = await resetFull(await configFor(root), quiet);
    expect(out.ok && out.backup).toBeFalsy();
    expect(existsSync(join(root, ".reset-backups"))).toBe(false);
  });

  it("refuses when .data is a symlink, and leaves the target's contents", async () => {
    const root = makeRepo();
    const target = tempDir();
    writeFileSync(join(target, "precious.txt"), "keep");
    symlinkSync(target, join(root, ".data"));
    const out = await resetFull(await configFor(root), quiet);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toMatch(/symlink/);
    expect(readdirSync(target)).toEqual(["precious.txt"]);
  });

  it("switches branch before removing anything: if the switch fails, the install and .data are still there", async () => {
    const root = makeRepo();
    git(root, "checkout", "-q", "governed");
    mkdirSync(join(root, ".data"));
    writeFileSync(join(root, ".data/run.sqlite"), "data");
    writeFileSync(join(root, ".git/index.lock"), ""); // makes the checkout fail
    const out = await resetFull(await configFor(root), quiet);
    expect(out.ok).toBe(false);
    expect(existsSync(join(root, "src/noblecloak/worker.ts"))).toBe(true);
    expect(existsSync(join(root, ".data/run.sqlite"))).toBe(true);
  });
});
