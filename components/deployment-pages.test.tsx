import { isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CallbackPage from "../app/auth/callback/page";
import PermissionsPage from "../app/automation/permissions/page";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const names = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach((n) => names(n, out));
  else if (isValidElement(node)) {
    out.push(typeof node.type === "string" ? node.type : ((node.type as { name?: string }).name ?? "?"));
    names((node.props as { children?: unknown }).children, out);
  }
  return out;
};

describe("/auth/callback", () => {
  it("is not found in mock mode: the mock has no sign-in", () => {
    expect(() => CallbackPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });
  it("renders the sign-in completion in deployment mode", () => {
    vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
    expect(names(CallbackPage())).toContain("CallbackClient");
  });
});

describe("the Permissions page", () => {
  it("in deployment mode hands the decision to the browser and sends no request from the server", async () => {
    vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
    vi.stubEnv("NC_BASE_URL", "https://govern.test");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const tree = names(await PermissionsPage());
    expect(tree).toContain("DeploymentPermissions");
    expect(f).not.toHaveBeenCalled();
  });
  it("in mock mode asks the mock, as before (the mock is down here, so it shows the stub)", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", f);
    const tree = names(await PermissionsPage());
    expect(tree).toContain("PermissionsStub");
    expect(tree).not.toContain("DeploymentPermissions");
    expect(f).toHaveBeenCalled();
  });
});
