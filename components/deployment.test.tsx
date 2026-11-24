import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@noblecloak/react/auth";
import { AppShell } from "./AppShell";
import { ApprovalPanelView, type PanelViewProps } from "./ApprovalPanel";
import { CallbackView } from "./CallbackClient";
import { answerOf, DeploymentPermissionsView } from "./DeploymentPermissions";
import { SignInBar, SignInView } from "./SignInBar";

afterEach(() => vi.unstubAllEnvs());
const noop = () => undefined;

describe("SignInView", () => {
  it("offers sign-in when signed out and says who is signed in otherwise", () => {
    const out = renderToStaticMarkup(<SignInView state={{ status: "signed_out" }} onSignIn={noop} onSignOut={noop} />);
    expect(out).toContain("Sign in to NobleCloak");
    expect(out).toContain("Not signed in");
    const inn = renderToStaticMarkup(<SignInView state={{ status: "signed_in" }} onSignIn={noop} onSignOut={noop} />);
    expect(inn).toContain("Signed in");
    expect(inn).toContain("Sign out");
    expect(inn).not.toContain("Sign in to NobleCloak");
  });
  it("disables the button while redirecting or completing, and states a denial or failure", () => {
    for (const status of ["redirecting", "completing"] as const) expect(renderToStaticMarkup(<SignInView state={{ status }} onSignIn={noop} onSignOut={noop} />)).toContain("disabled");
    expect(renderToStaticMarkup(<SignInView state={{ status: "denied" }} onSignIn={noop} onSignOut={noop} />)).toContain("Access was not granted");
    expect(renderToStaticMarkup(<SignInView state={{ status: "error", error: new AuthError("x", "boom") }} onSignIn={noop} onSignOut={noop} />)).toContain("Sign-in failed: boom");
  });
});

describe("SignInBar", () => {
  it("renders nothing in mock mode, so the mock demo's pages are unchanged", () => {
    expect(renderToStaticMarkup(<SignInBar />)).toBe("");
  });
  it("in deployment mode without settings, names what is missing instead of a sign-in button", () => {
    vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
    vi.stubEnv("NEXT_PUBLIC_NC_CLIENT_ID", undefined);
    const out = renderToStaticMarkup(<SignInBar />);
    expect(out).toContain("Deployment mode is not configured");
    expect(out).toContain("NEXT_PUBLIC_NC_CLIENT_ID is not set");
    expect(out).not.toContain("Sign in to NobleCloak");
  });
  it("in deployment mode with settings, shows the sign-in control", () => {
    vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
    vi.stubEnv("NEXT_PUBLIC_NC_API_URL", "https://govern.noblecloak.com");
    vi.stubEnv("NEXT_PUBLIC_NC_ISSUER", "https://auth.noblecloak.com");
    vi.stubEnv("NEXT_PUBLIC_NC_CLIENT_ID", "bnoauth_x");
    vi.stubEnv("NEXT_PUBLIC_NC_REDIRECT_URI", "http://localhost:3417/auth/callback");
    expect(renderToStaticMarkup(<SignInBar />)).toContain("Sign in to NobleCloak");
  });
});

describe("AppShell", () => {
  it("has no sign-in markup in mock mode", () => {
    expect(renderToStaticMarkup(<AppShell active="permissions">x</AppShell>)).not.toContain("signin");
  });
});

describe("DeploymentPermissionsView and answerOf", () => {
  const stub = <p>STUB</p>;
  it("shows the stub only when signed in and no Fernhill tool is registered", () => {
    expect(renderToStaticMarkup(<DeploymentPermissionsView answer="none" stub={stub} />)).toContain("STUB");
    for (const answer of ["signed_out", "checking", { error: "HTTP 500" }] as const) expect(renderToStaticMarkup(<DeploymentPermissionsView answer={answer} stub={stub} />)).not.toContain("STUB");
  });
  it("asks for a sign-in when signed out, and says a failed read failed", () => {
    expect(renderToStaticMarkup(<DeploymentPermissionsView answer="signed_out" stub={stub} />)).toContain("Sign in to NobleCloak to see");
    expect(renderToStaticMarkup(<DeploymentPermissionsView answer={{ error: "NobleCloak answered HTTP 500." }} stub={stub} />)).toContain("Could not read the rules. NobleCloak answered HTTP 500.");
  });
  it("answerOf reads a tools answer: registered, none, signed out, or an error that is not read as none", async () => {
    const tools = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
    expect(await answerOf(tools([{ tool_ref: "ext:fernhill-desk:slack_invite" }]))).toBe("registered");
    expect(await answerOf(tools([{ tool_ref: "mcp:other" }]))).toBe("none");
    expect(await answerOf(tools([]))).toBe("none");
    expect(await answerOf(new Response("{}", { status: 401 }))).toBe("signed_out");
    expect(await answerOf(new Response("{}", { status: 502 }))).toEqual({ error: "NobleCloak answered HTTP 502." });
    expect(await answerOf(new Response("not json", { status: 200 }))).toBe("none");
  });
});

describe("CallbackView", () => {
  it("says what is happening, a denial, and a failure", () => {
    expect(renderToStaticMarkup(<CallbackView status="working" />)).toContain("Signing in.");
    expect(renderToStaticMarkup(<CallbackView status="denied" />)).toContain("Access was not granted");
    expect(renderToStaticMarkup(<CallbackView status="error" message="bad code" />)).toContain("Sign-in failed: bad code");
  });
});

describe("ApprovalPanelView persona switch", () => {
  const props = (over: Partial<PanelViewProps> = {}): PanelViewProps => ({
    approvals: [{ id: "a", tool: "mercury_issue_card", waitingOn: "finance", canDecide: true, actionDigest: "d", state: "pending", args: {} }],
    persona: "priya", message: null, busyId: null, unreachable: false, reasons: {}, onReason: noop, onDecide: noop, onSwitch: noop, ...over,
  });
  it("is shown by default and hidden in deployment mode", () => {
    expect(renderToStaticMarkup(<ApprovalPanelView {...props()} />)).toContain("persona-switch");
    expect(renderToStaticMarkup(<ApprovalPanelView {...props({ hidePersona: true })} />)).not.toContain("persona-switch");
  });
});
