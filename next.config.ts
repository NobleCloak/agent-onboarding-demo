import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Stop `next dev` from writing AGENTS.md into the tree on every run.
  agentRules: false,
  // The dev-mode badge would sit on the screen a live audience is watching.
  devIndicators: false,
  // Pin the workspace root so a stray lockfile in a parent directory is ignored.
  turbopack: { root: path.resolve(import.meta.dirname) },
};
export default config;
