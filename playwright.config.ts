import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Fixed port so every run (and every screenshot) is deterministic. The app binds to 127.0.0.1 only, and
// "localhost" can resolve to ::1, so tests address it by IP (also what the proxy allowlist expects).
// FERNHILL_E2E_PORT lets a run use another port beside a dev server on 3417. FERNHILL_ALLOWED_ORIGINS, which proxy.ts
// checks the Host and Origin of every /api call against, defaults below to that port's origin, so no extra variable is needed.
const PORT = Number(process.env.FERNHILL_E2E_PORT ?? 3417);
const HOST = "127.0.0.1";
// The NobleCloak mock the app talks to and the approvals spec starts. Not 8787, which is the demo's own mock.
export const E2E_MOCK_PORT = Number(process.env.FERNHILL_E2E_MOCK_PORT ?? 8791);
// Where the governed spec's mock writes the agent's credential (the mock generates it on start).
export const E2E_CREDENTIAL_FILE = join(tmpdir(), `fernhill-e2e-${E2E_MOCK_PORT}.credentials.json`);
// Once NobleCloak is installed the app's agent is governed, so the specs that expect the ungoverned agent do not apply.
const governed = existsSync("src/noblecloak/governed-agent.ts");

export default defineConfig({
  testDir: "./e2e",
  testIgnore: governed ? ["**/run.spec.ts", "**/approvals.spec.ts"] : [],
  // The run lives in one shared store, so specs must not overlap.
  workers: 1,
  outputDir: "./test-results",
  use: { baseURL: `http://${HOST}:${PORT}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `node_modules/.bin/next dev -p ${PORT} -H ${HOST}`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_FERNHILL_MODE: "mock", FERNHILL_ALLOWED_ORIGINS: process.env.FERNHILL_ALLOWED_ORIGINS ?? `http://${HOST}:${PORT}`, NC_BASE_URL: `http://${HOST}:${E2E_MOCK_PORT}`, NOBLECLOAK_SP_CREDENTIALS: E2E_CREDENTIAL_FILE, NC_EXPECTED_PRINCIPAL: "svc_adapter" },
  },
});
