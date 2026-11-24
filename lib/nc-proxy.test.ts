import { describe, expect, it, vi } from "vitest";
import { forwardToNc, hasRegisteredTools, isAllowedNcRequest, scopeList } from "./nc-proxy";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

/** A fake mock: /__mock/tokens gives the admin token, everything else is handed to `answer`. */
function fakeMock(answer: (url: URL, init: RequestInit) => Response | Promise<Response> = () => Response.json({ data: [] })) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/__mock/tokens") return Response.json({ admin: TOKEN, creator: "x" });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, upstream: () => calls.filter((c) => c.url.pathname !== "/__mock/tokens") };
}
const deps = (fetch: typeof globalThis.fetch) => ({ baseUrl: "http://mock.test", fetch });
const req = (method: string, path: string, init: RequestInit = {}) => new Request(`http://app.test/api/nc/${path}`, { method, ...init });
const seg = (p: string) => p.split("/");

describe("isAllowedNcRequest", () => {
  it.each([
    ["GET", "v1/capabilities"],
    ["GET", "v1/tools"],
    ["GET", "v1/principals"],
    ["GET", "v1/connections"],
    ["GET", "v1/policies"],
    ["POST", "v1/policies"],
    ["GET", "v1/policies/pol_1"],
    ["PUT", "v1/policies/pol_1"],
    ["GET", "v1/policies/pol_1/versions"],
    ["POST", "v1/policies/pol_1/publish"],
    ["POST", "v1/policies/pol_1/retire"],
    ["POST", "v1/policies/pol_1/simulate"],
    ["DELETE", "v1/policies/pol_1/draft"],
  ])("allows %s %s", (method, path) => expect(isAllowedNcRequest(method, seg(path))).toBe(true));

  it.each([
    ["GET", "__mock/tokens"],
    ["GET", "__demo/token"],
    ["POST", "__mock/clock"],
    ["POST", "v1/approvals/appr_1/resolve"],
    ["POST", "v1/approvals/resolve/batch"],
    ["GET", "v1/approvals"],
    ["POST", "v1/decisions"],
    ["POST", "v1/tools"],
    ["POST", "v1/agents"],
    ["DELETE", "v1/policies/pol_1"],
    ["PATCH", "v1/policies/pol_1"],
    ["POST", "v1/capabilities"],
    ["GET", "v1/policies/pol_1/publish"],
    ["GET", "oauth/token"],
    ["GET", "v1"],
    ["GET", ""],
  ])("refuses %s %s", (method, path) => expect(isAllowedNcRequest(method, seg(path))).toBe(false));

  it("refuses a segment that climbs, splits or hides a path", () => {
    expect(isAllowedNcRequest("GET", ["v1", "policies", ".."])).toBe(false);
    expect(isAllowedNcRequest("GET", ["v1", "policies", "..", "..", "__mock", "tokens"])).toBe(false);
    expect(isAllowedNcRequest("GET", ["v1", "policies", "a/b"])).toBe(false);
    expect(isAllowedNcRequest("GET", ["v1", "policies", "a%2Fb"])).toBe(false);
    expect(isAllowedNcRequest("GET", ["v1", "policies", "x?y=1"])).toBe(false);
    expect(isAllowedNcRequest("GET", ["v1", "policies", "a\\b"])).toBe(false);
  });
});

describe("forwardToNc", () => {
  it("attaches the administrator's token and drops whatever the browser sent", async () => {
    const m = fakeMock();
    const res = await forwardToNc(req("GET", "v1/policies?state=published", { headers: { authorization: "Bearer placeholder", cookie: "fernhill_persona=sam", origin: "http://127.0.0.1:3417" } }), seg("v1/policies"), deps(m.fetch));
    expect(res.status).toBe(200);
    const [call] = m.upstream();
    expect(call!.url.toString()).toBe("http://mock.test/v1/policies?state=published");
    const h = new Headers(call!.init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("origin")).toBeNull();
  });

  it("refuses a cross-site read before calling the mock", async () => {
    const m = fakeMock();
    const res = await forwardToNc(req("GET", "v1/policies", { headers: { "sec-fetch-site": "cross-site" } }), seg("v1/policies"), deps(m.fetch));
    expect(res.status).toBe(403);
    expect(m.calls).toHaveLength(0);
    const same = await forwardToNc(req("GET", "v1/policies", { headers: { "sec-fetch-site": "same-origin" } }), seg("v1/policies"), deps(m.fetch));
    expect(same.status).toBe(200);
  });

  it("when Sec-Fetch-Site is present it must be same-origin: same-site and none are refused too", async () => {
    const m = fakeMock();
    for (const site of ["same-site", "none", "cross-site", "weird"]) {
      const res = await forwardToNc(req("GET", "v1/policies", { headers: { "sec-fetch-site": site } }), seg("v1/policies"), deps(m.fetch));
      expect(res.status, site).toBe(403);
    }
    expect(m.calls).toHaveLength(0);
    // Absent (curl, the e2e request fixture) is allowed.
    expect((await forwardToNc(req("GET", "v1/policies"), seg("v1/policies"), deps(m.fetch))).status).toBe(200);
  });

  it("passes the body and the content type of a write", async () => {
    const m = fakeMock((_u, init) => Response.json({ data: { echoed: new TextDecoder().decode(init.body as ArrayBuffer) } }, { status: 200 }));
    const res = await forwardToNc(req("PUT", "v1/policies/pol_1", { body: '{"a":1}', headers: { "content-type": "application/json" } }), seg("v1/policies/pol_1"), deps(m.fetch));
    expect(((await res.json()) as { data: { echoed: string } }).data.echoed).toBe('{"a":1}');
    expect(new Headers(m.upstream()[0]!.init.headers).get("content-type")).toBe("application/json");
  });

  it("refuses a path off the list without calling the mock at all", async () => {
    const m = fakeMock();
    for (const [method, path] of [["GET", "__mock/tokens"], ["POST", "v1/approvals/a1/resolve"], ["GET", "__demo/token"]] as const) {
      const res = await forwardToNc(req(method, path), seg(path), deps(m.fetch));
      expect(res.status).toBe(404);
    }
    expect(m.calls).toHaveLength(0);
  });

  it("never puts the token or a set-cookie in what it returns, even when the upstream sends them", async () => {
    const m = fakeMock(() => new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "s=1", "x-upstream": "1", etag: '"v1"' } }));
    const res = await forwardToNc(req("GET", "v1/tools"), seg("v1/tools"), deps(m.fetch));
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream")).toBeNull();
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(JSON.stringify([...res.headers]) + (await res.text())).not.toContain(TOKEN);
  });

  it("passes the mock's error status and body through", async () => {
    const m = fakeMock(() => Response.json({ error: { code: "conflict" } }, { status: 409 }));
    const res = await forwardToNc(req("POST", "v1/policies/pol_1/publish"), seg("v1/policies/pol_1/publish"), deps(m.fetch));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict" } });
  });

  it("answers 502 without the address or a token when the mock is down", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await forwardToNc(req("GET", "v1/tools"), seg("v1/tools"), deps(down));
    spy.mockRestore();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("mock.test");
    expect(text).toContain("not answering");
  });
});

describe("hasRegisteredTools", () => {
  const tools = (...refs: string[]) => Response.json({ data: refs.map((tool_ref) => ({ tool_ref })) });

  it("is true once a Fernhill tool is registered, whether or not any rule is still published", async () => {
    const m = fakeMock(() => tools("mcp:tracker:search", "ext:fernhill-desk:slack_invite"));
    expect(await hasRegisteredTools(deps(m.fetch))).toBe(true);
    expect(m.upstream()[0]!.url.pathname).toBe("/v1/tools");
    // The policy list is not consulted: a page whose rules were all retired still shows the module.
    expect(m.upstream().every((c) => c.url.pathname !== "/v1/policies")).toBe(true);
  });

  it("is false when only the mock's own seeded tools exist, or nothing is registered", async () => {
    expect(await hasRegisteredTools(deps(fakeMock(() => tools("mcp:tracker:search", "ext:local:send_email")).fetch))).toBe(false);
    expect(await hasRegisteredTools(deps(fakeMock(() => tools()).fetch))).toBe(false);
  });

  it("is false, not an error, when the mock is down or answers badly", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    expect(await hasRegisteredTools(deps(down))).toBe(false);
    // A failing answer that still parses must not count as "registered".
    expect(await hasRegisteredTools(deps(fakeMock(() => Response.json({ data: [{ tool_ref: "ext:fernhill-desk:slack_invite" }] }, { status: 500 })).fetch))).toBe(false);
    expect(await hasRegisteredTools(deps(fakeMock(() => new Response("<html>", { status: 200 })).fetch))).toBe(false);
  });
});

describe("what the module is shown", () => {
  const tools = { data: [{ tool_ref: "mcp:tracker:search" }, { tool_ref: "ext:local:send_email" }, { tool_ref: "ext:fernhill-desk:slack_invite" }], meta: { next: null } };
  const policies = {
    data: [
      { id: "a", targets: { tools: ["mcp:tracker:search", "ext:local:send_email"] } },
      { id: "b", targets: { tools: ["ext:fernhill-desk:slack_invite"] } },
      { id: "c", targets: { tools: "all" } },
      { id: "d" },
      { id: "e", targets: { tools: ["mcp:crm:delete_account"] } },
    ],
  };

  it("cuts the tool list to Fernhill's and keeps the envelope", async () => {
    const m = fakeMock(() => Response.json(tools));
    const res = await forwardToNc(req("GET", "v1/tools?limit=200"), seg("v1/tools"), deps(m.fetch));
    expect(await res.json()).toEqual({ data: [{ tool_ref: "ext:fernhill-desk:slack_invite" }], meta: { next: null } });
  });

  it("cuts the policy list to rules that name a Fernhill tool or cover every tool", async () => {
    const m = fakeMock(() => Response.json(policies));
    const res = await forwardToNc(req("GET", "v1/policies?limit=200"), seg("v1/policies"), deps(m.fetch));
    expect(((await res.json()) as { data: { id: string }[] }).data.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("leaves other lists and a body it cannot read alone", () => {
    expect(scopeList(["v1", "principals"], JSON.stringify(tools))).toBeNull();
    expect(scopeList(["v1", "tools"], "<html>")).toBeNull();
    expect(scopeList(["v1", "tools"], '{"data":"x"}')).toBeNull();
  });

  it("does not cut a write's answer", async () => {
    const m = fakeMock(() => Response.json({ data: { id: "x", targets: { tools: ["mcp:tracker:search"] } } }));
    const res = await forwardToNc(req("PUT", "v1/policies/pol_1", { body: "{}" }), seg("v1/policies/pol_1"), deps(m.fetch));
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe("x");
  });
});
