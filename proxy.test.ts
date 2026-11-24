import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { config, isAllowedHost, isAllowedWrite, proxy } from "./proxy";

const DEFAULTS = ["http://127.0.0.1:3417", "http://localhost:3417"];
const req = (method: string, headers: Record<string, string> = {}, path = "/api/run") =>
  new NextRequest(`http://127.0.0.1:3417${path}`, { method, headers });

afterEach(() => {
  delete process.env.FERNHILL_ALLOWED_ORIGINS;
});

describe("isAllowedWrite", () => {
  it("allows reads regardless of origin", () => {
    expect(isAllowedWrite({ method: "GET", origin: "https://evil.test", secFetchSite: "cross-site" }, DEFAULTS)).toBe(true);
  });
  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects a cross-site %s", (method) => {
    expect(isAllowedWrite({ method, origin: null, secFetchSite: "cross-site" }, DEFAULTS)).toBe(false);
  });
  it("rejects an Origin outside the allowlist, including null", () => {
    expect(isAllowedWrite({ method: "POST", origin: "https://evil.test", secFetchSite: "same-site" }, DEFAULTS)).toBe(false);
    expect(isAllowedWrite({ method: "POST", origin: "null", secFetchSite: null }, DEFAULTS)).toBe(false);
  });
  it("allows allowlisted origins and header-less curl", () => {
    expect(isAllowedWrite({ method: "POST", origin: "http://localhost:3417", secFetchSite: "same-origin" }, DEFAULTS)).toBe(true);
    expect(isAllowedWrite({ method: "DELETE", origin: null, secFetchSite: null }, DEFAULTS)).toBe(true);
  });
  it("is case-insensitive on the method", () => {
    expect(isAllowedWrite({ method: "post", origin: "https://evil.test", secFetchSite: null }, DEFAULTS)).toBe(false);
  });
});

describe("proxy", () => {
  it("returns 403 for a cross-site POST to /api/run", async () => {
    const res = proxy(req("POST", { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });
  it("returns 403 for a foreign Origin", () => {
    expect(proxy(req("DELETE", { origin: "https://evil.test" })).status).toBe(403);
  });
  it("passes the app's own origin through", () => {
    const res = proxy(req("POST", { origin: "http://127.0.0.1:3417", "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
  it("passes curl (no Origin, no Sec-Fetch-Site)", () => {
    expect(proxy(req("POST")).headers.get("x-middleware-next")).toBe("1");
  });
  it("reads the allowlist from FERNHILL_ALLOWED_ORIGINS at request time", () => {
    process.env.FERNHILL_ALLOWED_ORIGINS = "https://demo.example, http://127.0.0.1:4000/";
    expect(proxy(req("POST", { origin: "https://demo.example", host: "demo.example" })).status).toBe(200);
    expect(proxy(req("POST", { origin: "http://127.0.0.1:4000", host: "127.0.0.1:4000" })).status).toBe(200);
    expect(proxy(req("POST", { origin: "http://127.0.0.1:3417" })).status).toBe(403);
  });
  it("covers the NobleCloak pass-through: a foreign page cannot publish a rule through it", async () => {
    const path = "/api/nc/v1/policies/pol_1/publish";
    expect(proxy(req("POST", { "sec-fetch-site": "cross-site" }, path)).status).toBe(403);
    expect(proxy(req("PUT", { origin: "https://evil.test" }, "/api/nc/v1/policies/pol_1")).status).toBe(403);
    expect(proxy(req("DELETE", { origin: "https://evil.test" }, "/api/nc/v1/policies/pol_1/draft")).status).toBe(403);
    expect(proxy(req("POST", { origin: "http://127.0.0.1:3417", "sec-fetch-site": "same-origin" }, path)).status).toBe(200);
    expect(new RegExp(`^${config.matcher.replace(":path*", ".*")}$`).test(path)).toBe(true);
  });
  it("does not touch non-API paths", () => {
    expect(proxy(req("POST", { "sec-fetch-site": "cross-site" }, "/people")).status).toBe(200);
  });
});

describe("isAllowedHost", () => {
  it("accepts 127.0.0.1 and localhost on the app's port, and nothing else, by default", () => {
    expect(isAllowedHost("127.0.0.1:3417", DEFAULTS)).toBe(true);
    expect(isAllowedHost("localhost:3417", DEFAULTS)).toBe(true);
    expect(isAllowedHost("LOCALHOST:3417", DEFAULTS)).toBe(true);
    for (const host of ["evil.test", "evil.test:3417", "127.0.0.1", "127.0.0.1:3418", "127.0.0.1.evil.test:3417", "0.0.0.0:3417", "[::1]:3417", "", null]) {
      expect(isAllowedHost(host, DEFAULTS)).toBe(false);
    }
  });
  it("follows a configured port and host", () => {
    const configured = ["http://127.0.0.1:3427", "https://demo.example"];
    expect(isAllowedHost("127.0.0.1:3427", configured)).toBe(true);
    expect(isAllowedHost("localhost:3427", configured)).toBe(true);
    expect(isAllowedHost("demo.example", configured)).toBe(true);
    expect(isAllowedHost("127.0.0.1:3417", configured)).toBe(false);
  });
});

describe("proxy and DNS rebinding", () => {
  it.each(["GET", "POST", "PUT", "DELETE"])("rejects a %s whose Host is not the app's own, even with no Origin or Sec-Fetch-Site", (method) => {
    expect(proxy(req(method, { host: "rebound.evil.test:3417" }, "/api/nc/v1/policies")).status).toBe(403);
    expect(proxy(req(method, { host: "rebound.evil.test:3417" }, "/api/approvals")).status).toBe(403);
  });
  it("lets the app's own hosts through for reads and writes", () => {
    expect(proxy(req("GET", { host: "127.0.0.1:3417" }, "/api/nc/v1/policies")).status).toBe(200);
    expect(proxy(req("POST", { host: "localhost:3417" }, "/api/run")).status).toBe(200);
  });
  it("accepts the e2e port from FERNHILL_ALLOWED_ORIGINS", () => {
    process.env.FERNHILL_ALLOWED_ORIGINS = "http://127.0.0.1:3427";
    expect(proxy(req("GET", { host: "127.0.0.1:3427" }, "/api/run")).status).toBe(200);
    expect(proxy(req("GET", { host: "127.0.0.1:3417" }, "/api/run")).status).toBe(403);
  });
});
