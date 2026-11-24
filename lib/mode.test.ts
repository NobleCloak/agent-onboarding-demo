import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBuiltMode, assertMock, bearerOf, currentMode, DeploymentConfigError, modeOf, parseDeploymentConfig, upstreamBase } from "./mode";

afterEach(() => vi.unstubAllEnvs());

const GOOD = {
  NEXT_PUBLIC_NC_API_URL: "https://govern.noblecloak.com",
  NEXT_PUBLIC_NC_ISSUER: "https://auth.noblecloak.com",
  NEXT_PUBLIC_NC_CLIENT_ID: "bnoauth_abc",
  NEXT_PUBLIC_NC_REDIRECT_URI: "http://localhost:3417/auth/callback",
};

describe("modeOf", () => {
  it("is mock by default, for an empty value and for mock", () => {
    expect(modeOf({})).toBe("mock");
    expect(modeOf({ NEXT_PUBLIC_FERNHILL_MODE: "  " })).toBe("mock");
    expect(modeOf({ NEXT_PUBLIC_FERNHILL_MODE: "mock" })).toBe("mock");
  });
  it("is deployment only when it says so", () => expect(modeOf({ NEXT_PUBLIC_FERNHILL_MODE: "deployment" })).toBe("deployment"));
  it("refuses a value it does not know instead of reading it as mock", () => {
    expect(() => modeOf({ NEXT_PUBLIC_FERNHILL_MODE: "prod" })).toThrow(DeploymentConfigError);
  });
  it("currentMode reads the environment at call time", () => {
    expect(currentMode()).toBe("mock");
    vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
    expect(currentMode()).toBe("deployment");
  });
});

describe("assertMock", () => {
  it("passes in mock mode and throws in deployment mode", () => {
    expect(() => assertMock("x", "mock")).not.toThrow();
    expect(() => assertMock("The thing", "deployment")).toThrow(/The thing is mock only/);
  });
});

describe("parseDeploymentConfig", () => {
  it("accepts the documented values", () => expect(parseDeploymentConfig(GOOD)).toEqual({ ok: true, config: { apiUrl: GOOD.NEXT_PUBLIC_NC_API_URL, issuer: GOOD.NEXT_PUBLIC_NC_ISSUER, clientId: "bnoauth_abc", redirectUri: GOOD.NEXT_PUBLIC_NC_REDIRECT_URI } }));
  it("carries an optional scope", () => expect(parseDeploymentConfig({ ...GOOD, NEXT_PUBLIC_NC_SCOPE: " approvals:resolve policies:write " })).toMatchObject({ ok: true, config: { scope: "approvals:resolve policies:write" } }));
  it("names every missing value", () => {
    const r = parseDeploymentConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.split(" ")[0])).toEqual(["NEXT_PUBLIC_NC_API_URL", "NEXT_PUBLIC_NC_ISSUER", "NEXT_PUBLIC_NC_CLIENT_ID", "NEXT_PUBLIC_NC_REDIRECT_URI"]);
  });
  it.each([
    ["NEXT_PUBLIC_NC_API_URL", "https://govern.noblecloak.com/", /no path or trailing slash/],
    ["NEXT_PUBLIC_NC_API_URL", "http://govern.noblecloak.com", /uses https/],
    ["NEXT_PUBLIC_NC_ISSUER", "http://auth.noblecloak.com", /https/],
    ["NEXT_PUBLIC_NC_ISSUER", "auth", /absolute URL/],
    ["NEXT_PUBLIC_NC_CLIENT_ID", "REPLACE_ME", /REPLACE_ME/],
    ["NEXT_PUBLIC_NC_REDIRECT_URI", "http://127.0.0.1:3417/auth/callback", /https \(or http:\/\/localhost\)/],
    ["NEXT_PUBLIC_NC_REDIRECT_URI", "http://localhost:3417/auth/callback?x=1", /exact/],
  ])("refuses %s = %s", (name, value, message) => {
    const r = parseDeploymentConfig({ ...GOOD, [name]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toMatch(message);
  });
});

describe("upstreamBase", () => {
  it("mock mode keeps its old order: deps, NC_BASE_URL, then the mock's own address", () => {
    expect(upstreamBase({ mode: "mock", baseUrl: "http://a.test/" })).toBe("http://a.test");
    vi.stubEnv("NC_BASE_URL", "http://env.test");
    expect(upstreamBase({ mode: "mock" })).toBe("http://env.test");
    vi.stubEnv("NC_BASE_URL", undefined);
    expect(upstreamBase({ mode: "mock" })).toBe("http://127.0.0.1:8787");
  });
  it("deployment mode has no default: unset fails loudly and never answers the mock's address", () => {
    vi.stubEnv("NC_BASE_URL", undefined);
    expect(() => upstreamBase({ mode: "deployment" })).toThrow(/needs NC_BASE_URL/);
    vi.stubEnv("NC_BASE_URL", "  ");
    expect(() => upstreamBase({ mode: "deployment" })).toThrow(/needs NC_BASE_URL/);
  });
  it("deployment mode refuses an insecure origin, including the mock's", () => {
    vi.stubEnv("NC_BASE_URL", "http://127.0.0.1:8787");
    expect(() => upstreamBase({ mode: "deployment" })).toThrow(/https/);
  });
  it("deployment mode uses NC_BASE_URL when it is the origin sign-in is configured for", () => {
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", "https://govern.noblecloak.com");
    vi.stubEnv("NC_BASE_URL", "https://govern.noblecloak.com/");
    expect(upstreamBase({ mode: "deployment" })).toBe("https://govern.noblecloak.com");
  });
  it("deployment mode refuses an NC_BASE_URL that is not NEXT_PUBLIC_NC_API_URL, so a stray one never gets a person's token", () => {
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", "https://govern.noblecloak.com");
    vi.stubEnv("NC_BASE_URL", "http://localhost:8787");
    expect(() => upstreamBase({ mode: "deployment" })).toThrow(/NEXT_PUBLIC_NC_API_URL/);
    vi.stubEnv("NC_BASE_URL", "https://other.example.com");
    expect(() => upstreamBase({ mode: "deployment" })).toThrow(/NEXT_PUBLIC_NC_API_URL/);
  });
  it("deployment mode refuses when NEXT_PUBLIC_NC_API_URL is not set", () => {
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", undefined);
    vi.stubEnv("NC_BASE_URL", "https://govern.noblecloak.com");
    expect(() => upstreamBase({ mode: "deployment" })).toThrow(/NEXT_PUBLIC_NC_API_URL/);
  });
  it("mock mode does not look at NEXT_PUBLIC_NC_API_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", "https://govern.noblecloak.com");
    vi.stubEnv("NC_BASE_URL", "http://localhost:8787");
    expect(upstreamBase({ mode: "mock" })).toBe("http://localhost:8787");
  });
});

describe("bearerOf", () => {
  const h = (value?: string) => new Headers(value === undefined ? {} : { authorization: value });
  it("reads a bearer token", () => expect(bearerOf(h("Bearer abc.def"))).toBe("abc.def"));
  it("is case-insensitive about the scheme", () => expect(bearerOf(h("bearer abc"))).toBe("abc"));
  it.each([undefined, "", "Basic abc", "Bearer", "Bearer a b"])("is null for %s", (v) => expect(bearerOf(h(v))).toBeNull());
});

describe("assertBuiltMode", () => {
  it("passes when the start script's intended mode is the built mode, or none is named", () => {
    expect(() => assertBuiltMode("mock", "mock")).not.toThrow();
    expect(() => assertBuiltMode("deployment", "deployment")).not.toThrow();
    expect(() => assertBuiltMode(undefined, "deployment")).not.toThrow();
  });
  it("refuses a mock build started as deployment", () => {
    expect(() => assertBuiltMode("deployment", "mock")).toThrow(/built in mock mode.*build:deployment/s);
  });
  it("refuses a deployment build started as mock", () => {
    expect(() => assertBuiltMode("mock", "deployment")).toThrow(/built in deployment mode.*bun run build\b/s);
  });
});
