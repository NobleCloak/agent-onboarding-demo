import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteFor, RunNoteView } from "./OnboardingRun";

afterEach(() => vi.unstubAllEnvs());

function deploymentEnv() {
  vi.stubEnv("NEXT_PUBLIC_FERNHILL_MODE", "deployment");
  vi.stubEnv("NEXT_PUBLIC_NC_API_URL", "https://govern.noblecloak.com");
  vi.stubEnv("NEXT_PUBLIC_NC_ISSUER", "https://auth.noblecloak.com");
  vi.stubEnv("NEXT_PUBLIC_NC_CLIENT_ID", "bnoauth_x");
  vi.stubEnv("NEXT_PUBLIC_NC_REDIRECT_URI", "http://localhost:3417/auth/callback");
}

describe("noteFor", () => {
  it("deployment mode: a 401 asks for a sign-in", () => expect(noteFor(401, "retry", "deployment")).toEqual({ kind: "sign_in" }));
  it("deployment mode: any other failure keeps the retry note", () => {
    for (const status of [null, 500, 502, 403]) expect(noteFor(status, "retry", "deployment")).toEqual({ kind: "retry", text: "retry" });
  });
  it("mock mode: a 401 is not a sign-in matter", () => expect(noteFor(401, "retry", "mock")).toEqual({ kind: "retry", text: "retry" }));
});

describe("RunNoteView", () => {
  it("sign_in shows the sign-in control, not the retry wording", () => {
    deploymentEnv();
    const out = renderToStaticMarkup(<RunNoteView note={{ kind: "sign_in" }} />);
    expect(out).toContain("Sign in to NobleCloak");
    expect(out).toContain('data-testid="signin"');
    expect(out).not.toContain("trouble reaching");
  });
  it("retry shows its text", () => {
    expect(renderToStaticMarkup(<RunNoteView note={{ kind: "retry", text: "Having trouble reaching the run. Retrying." }} />)).toContain("Having trouble reaching the run");
  });
});

describe("OnboardingRun wiring", () => {
  it("classifies the poll, start and reset failures through noteFor and renders RunNoteView", () => {
    const src = readFileSync(new URL("./OnboardingRun.tsx", import.meta.url), "utf8");
    expect(src.match(/noteFor\(/g)!.length).toBeGreaterThanOrEqual(5);
    expect(src).toContain("<RunNoteView note={note} />");
    expect(src).not.toMatch(/setNote\("/);
  });
});
