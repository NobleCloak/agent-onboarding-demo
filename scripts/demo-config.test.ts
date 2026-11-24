import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireRoot } from "./demo-config";
import { makeRepo, tempDir } from "./test-support/fixtures";

describe("requireRoot", () => {
  it("returns the checkout the script lives in when the shell is standing there", () => {
    const root = makeRepo();
    mkdirSync(join(root, "scripts"));
    expect(requireRoot(root, join(root, "scripts"))).toMatch(/fernhill-repo-/);
  });

  it("refuses when the shell is in another directory, or a subdirectory", () => {
    const root = makeRepo();
    mkdirSync(join(root, "scripts"));
    expect(() => requireRoot(tempDir(), join(root, "scripts"))).toThrow(/Run this from/);
    expect(() => requireRoot(join(root, "scripts"), join(root, "scripts"))).toThrow(/Run this from/);
  });

  it("refuses a copy of the scripts that is not the top of a git checkout", () => {
    const outside = tempDir();
    mkdirSync(join(outside, "scripts"));
    expect(() => requireRoot(outside, join(outside, "scripts"))).toThrow(/not a git checkout/);
    const root = makeRepo();
    mkdirSync(join(root, "app/scripts"), { recursive: true });
    expect(() => requireRoot(join(root, "app"), join(root, "app/scripts"))).toThrow(/not its top level/);
  });

  it("follows a symlinked checkout to the same real root", () => {
    const root = makeRepo();
    mkdirSync(join(root, "scripts"));
    const link = join(tempDir(), "link");
    symlinkSync(root, link);
    expect(requireRoot(link, join(link, "scripts"))).toBe(requireRoot(root, join(root, "scripts")));
  });
});
