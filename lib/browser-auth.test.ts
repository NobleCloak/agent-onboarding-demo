import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerFetch, sharedAuth } from "./browser-auth";
import { DeploymentConfigError } from "./mode";

afterEach(() => vi.unstubAllEnvs());

const CONFIG = { apiUrl: "https://govern.noblecloak.com", issuer: "https://auth.noblecloak.com", clientId: "bnoauth_x", redirectUri: "http://localhost:3417/auth/callback" };

describe("bearerFetch", () => {
  it("attaches the token and keeps the rest of the call", async () => {
    const seen: { input: unknown; init: RequestInit | undefined }[] = [];
    const f = bearerFetch(async () => "tok", (async (input, init) => (seen.push({ input, init }), new Response("{}"))) as typeof fetch);
    await f("/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.input).toBe("/api/approvals");
    const headers = new Headers(seen[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.init).toMatchObject({ method: "POST", body: "{}", cache: "no-store" });
  });

  it("asks for the token on every call, so a refreshed one is used", async () => {
    let n = 0;
    const auths: string[] = [];
    const f = bearerFetch(async () => `t${++n}`, (async (_i, init) => (auths.push(new Headers(init?.headers).get("authorization") ?? ""), new Response("{}"))) as typeof fetch);
    await f("/a");
    await f("/b");
    expect(auths).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("answers 401 locally, sending nothing, when there is no token", async () => {
    const doFetch = vi.fn();
    const res = await bearerFetch(async () => { throw new Error("signed out"); }, doFetch as unknown as typeof fetch)("/api/approvals");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, status: 401, message: expect.stringContaining("Sign in") });
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("sharedAuth", () => {
  it("is one object for one configuration and a new one for another", () => {
    const a = sharedAuth(CONFIG);
    expect(sharedAuth({ ...CONFIG })).toBe(a);
    expect(sharedAuth({ ...CONFIG, clientId: "bnoauth_y" })).not.toBe(a);
  });
  it("passes the module's refusal of an insecure issuer on instead of hiding it", () => {
    expect(() => sharedAuth({ ...CONFIG, issuer: "http://auth.noblecloak.com" })).toThrow(/https/);
  });
  it("without settings in the environment, says which are missing", () => {
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_NC_ISSUER", undefined);
    vi.stubEnv("NEXT_PUBLIC_NC_CLIENT_ID", undefined);
    vi.stubEnv("NEXT_PUBLIC_NC_REDIRECT_URI", undefined);
    expect(() => sharedAuth()).toThrow(DeploymentConfigError);
    expect(() => sharedAuth()).toThrow(/NEXT_PUBLIC_NC_CLIENT_ID is not set/);
  });
});
