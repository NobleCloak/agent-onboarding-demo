import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoNew, type Runner } from "./demo-new";
import { BASE, git, makeRepo, put, tempDir } from "./test-support/fixtures";

/** An origin (bare) with the base and governed branches, and a source checkout cloned from it, as a presenter has. */
function setup() {
  const seed = makeRepo();
  const origin = join(tempDir("fernhill-origin-"), "origin.git");
  git(seed, "clone", "-q", "--bare", seed, origin);
  const source = join(tempDir("fernhill-source-"), "checkout");
  git(tempDir(), "clone", "-q", "--branch", BASE, origin, source);
  return { origin, source };
}

const recorder = () => {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const run: Runner = (cmd, args, cwd) => void calls.push({ cmd, args, cwd });
  return { calls, run };
};

const baseOpts = (demos: string, home: string, run: Runner, lines: string[]) => ({
  baseBranch: BASE,
  governedBranch: "governed",
  home,
  env: { FERNHILL_DEMOS_DIR: demos },
  now: new Date(2026, 10, 3, 12, 0, 0),
  run,
  log: (m: string) => lines.push(m),
});

describe("demo:new", () => {
  it("clones the base branch from origin into the demos folder, installs there, copies nothing from the source checkout, and prints the next commands", async () => {
    const { source } = setup();
    // Everything git-ignored in the source: secrets, run data, a build cache.
    put(source, ".env.local", "NC_BASE_URL=http://127.0.0.1:8787\nSECRET=hunter2\n");
    put(source, ".data/noblecloak-sp.credentials.json", "{\"private_jwk\":\"secret\"}");
    put(source, "node_modules/x/index.js", "x");
    const demos = tempDir("fernhill-demos-");
    const { calls, run } = recorder();
    const lines: string[] = [];

    const out = await demoNew(source, "rehearsal", baseOpts(demos, tempDir(), run, lines));

    expect(out.ok).toBe(true);
    const target = join(demos, "fernhill-rehearsal");
    expect(out.ok && out.target).toBe(target);
    expect(git(target, "branch", "--show-current").trim()).toBe(BASE);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("readme\n");
    for (const leftover of [".env.local", ".data", "node_modules"]) expect(existsSync(join(target, leftover))).toBe(false);
    expect(calls).toEqual([{ cmd: "bun", args: ["install"], cwd: target }]);
    const said = lines.join("\n");
    expect(said).toContain(`cd ${target}`);
    expect(said).toContain("bun run demo");
    expect(said).toContain("bun run preflight");
    expect(said).toMatch(/Claude Code/);
  });

  it("names the folder after the date when no name is given, and defaults to ~/demos", async () => {
    const { source } = setup();
    const home = tempDir("fernhill-home-");
    const { run } = recorder();
    const out = await demoNew(source, undefined, { ...baseOpts("", home, run, []), env: {} });
    expect(out.ok && out.target).toBe(join(home, "demos", "fernhill-2026-11-03"));
  });

  it("refuses when the target exists, and leaves it as it was", async () => {
    const { source } = setup();
    const demos = tempDir("fernhill-demos-");
    mkdirSync(join(demos, "fernhill-a"));
    writeFileSync(join(demos, "fernhill-a/keep.txt"), "mine");
    const { calls, run } = recorder();
    const out = await demoNew(source, "a", baseOpts(demos, tempDir(), run, []));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toMatch(/already exists/);
    expect(readFileSync(join(demos, "fernhill-a/keep.txt"), "utf8")).toBe("mine");
    expect(calls).toEqual([]);
  });

  it("refuses a target under ~/bianoble, where the parent CLAUDE.md would load, and clones nothing", async () => {
    const { source } = setup();
    const home = tempDir("fernhill-home-");
    const demos = join(home, "bianoble", "demos");
    const { calls, run } = recorder();
    const out = await demoNew(source, "x", baseOpts(demos, home, run, []));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toMatch(/~\/bianoble/);
    expect(existsSync(demos)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a name that is not a plain folder name", async () => {
    const { source } = setup();
    const demos = tempDir("fernhill-demos-");
    const { run } = recorder();
    for (const name of ["../escape", "a/b", "", "-x", "a b"]) {
      const out = await demoNew(source, name, baseOpts(demos, tempDir(), run, []));
      expect(out.ok, name).toBe(false);
    }
  });

  it("refuses when the source checkout has no origin", async () => {
    const lonely = makeRepo();
    const { run } = recorder();
    const out = await demoNew(lonely, "x", baseOpts(tempDir(), tempDir(), run, []));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toMatch(/origin/);
  });

  it("leaves nothing behind when the clone fails", async () => {
    const { source, origin } = setup();
    git(source, "remote", "set-url", "origin", join(origin, "nowhere"));
    const demos = tempDir("fernhill-demos-");
    const { calls, run } = recorder();
    const out = await demoNew(source, "x", baseOpts(demos, tempDir(), run, []));
    expect(out.ok).toBe(false);
    expect(existsSync(join(demos, "fernhill-x"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reports an install failure and leaves the clone for inspection", async () => {
    const { source } = setup();
    const demos = tempDir("fernhill-demos-");
    const out = await demoNew(source, "x", baseOpts(demos, tempDir(), () => { throw new Error("registry unreachable"); }, []));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons.join(" ")).toMatch(/bun install failed.*registry unreachable/);
    expect(existsSync(join(demos, "fernhill-x/package.json"))).toBe(true);
  });

  it("has the governed fallback branch available in the copy, and warns when origin lacks it", async () => {
    const { source, origin } = setup();
    const demos = tempDir("fernhill-demos-");
    const { run } = recorder();
    const lines: string[] = [];
    const out = await demoNew(source, "ok", baseOpts(demos, tempDir(), run, lines));
    expect(out.ok).toBe(true);
    const target = join(demos, "fernhill-ok");
    git(target, "checkout", "-q", "governed"); // the cut-over works from a clean copy
    expect(existsSync(join(target, "src/noblecloak/worker.ts"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/WARNING/);

    git(origin, "branch", "-q", "-D", "governed");
    const lines2: string[] = [];
    const out2 = await demoNew(source, "missing", baseOpts(demos, tempDir(), run, lines2));
    expect(out2.ok).toBe(true);
    expect(lines2.join("\n")).toMatch(/WARNING.*governed.*not on origin/s);
  });
  it("refuses a remote URL with embedded credentials, without printing it or cloning, and points to a credential helper", async () => {
    const { source } = setup();
    const demos = tempDir("fernhill-demos-");
    const { calls, run } = recorder();
    for (const url of ["https://alice:s3cr3tpass@github.com/org/repo.git", "https://ghp_tokenvalue@github.com/org/repo.git", "ssh://git:pw@example.test/org/repo.git"]) {
      git(source, "remote", "set-url", "origin", url);
      const lines: string[] = [];
      const out = await demoNew(source, "c", baseOpts(demos, tempDir(), run, lines));
      expect(out.ok, url).toBe(false);
      const said = lines.join("\n") + (out.ok ? "" : out.reasons.join("\n"));
      expect(said).toMatch(/credential helper/);
      expect(said).not.toMatch(/s3cr3tpass|ghp_tokenvalue|alice|:pw@/);
    }
    expect(existsSync(join(demos, "fernhill-c"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("accepts ordinary https, scp-style ssh and user-only ssh:// remotes", async () => {
    const { isCredentialedUrl } = await import("./demo-new");
    for (const url of ["https://github.com/org/repo.git", "git@github.com:org/repo.git", "ssh://git@github.com/org/repo.git", "/tmp/local/repo.git", "file:///tmp/local/repo.git"]) expect(isCredentialedUrl(url), url).toBe(false);
    for (const url of ["https://u:p@host/r.git", "http://token@host/r.git", "ssh://u:p@host/r.git"]) expect(isCredentialedUrl(url), url).toBe(true);
  });
});
