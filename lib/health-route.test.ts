import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../app/api/health/route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("answers 200 with the mode, and contacts nothing", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
  const res = GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, mode: "deployment" });
  vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "");
  expect(await GET().json()).toEqual({ ok: true, mode: "mock" });
  expect(fetchSpy).not.toHaveBeenCalled();
});
