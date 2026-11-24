import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../instrumentation";

afterEach(() => vi.unstubAllEnvs());

// The suite builds in mock mode (vitest.config.ts), so a start script that says deployment is a mismatch.
describe("instrumentation register", () => {
  it("throws at startup when the start script's mode differs from the built mode", async () => {
    vi.stubEnv("FERNHILL_RUN_MODE", "deployment");
    await expect(register()).rejects.toThrow(/built in mock mode/);
  });
  it("starts when the modes agree or the start script names none", async () => {
    vi.stubEnv("FERNHILL_RUN_MODE", "mock");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("FERNHILL_RUN_MODE", undefined);
    await expect(register()).resolves.toBeUndefined();
  });
});
