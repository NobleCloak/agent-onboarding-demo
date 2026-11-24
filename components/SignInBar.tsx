"use client";

import type { AuthState, BrowserAuth } from "@noblecloak/react/auth";
import { useAuthState } from "@noblecloak/react/auth";
import { LogIn, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { logFault, sharedAuth } from "../lib/browser-auth";
import { currentMode, DeploymentConfigError } from "../lib/mode";
import { ConfigProblem } from "./ConfigProblem";

export const SIGN_IN_LABEL = "Sign in to NobleCloak";

export type SignInViewProps = { state: AuthState; onSignIn: () => void; onSignOut: () => void };

/** The sign-in control. Nothing signs anyone in but a click on it. */
export function SignInView({ state, onSignIn, onSignOut }: SignInViewProps) {
  if (state.status === "signed_in") {
    return (
      <div className="signin" data-testid="signin" data-state="signed_in">
        <span className="k">NobleCloak</span>
        <b>Signed in</b>
        <button type="button" className="btn alt" onClick={onSignOut}>
          <LogOut aria-hidden="true" />
          Sign out
        </button>
      </div>
    );
  }
  const busy = state.status === "redirecting" || state.status === "completing";
  return (
    <div className="signin" data-testid="signin" data-state={state.status}>
      <span className="k">NobleCloak</span>
      <b>{state.status === "denied" ? "Access was not granted" : state.status === "error" ? `Sign-in failed: ${state.error.message}` : state.status === "signed_out" && state.message ? state.message : "Not signed in"}</b>
      <button type="button" className="btn go" disabled={busy} onClick={onSignIn}>
        <LogIn aria-hidden="true" />
        {SIGN_IN_LABEL}
      </button>
    </div>
  );
}

function Connected({ auth }: { auth: BrowserAuth }) {
  const state = useAuthState(auth);
  useEffect(() => {
    void auth.restore();
  }, [auth]);
  return <SignInView state={state} onSignIn={() => void auth.signIn(window.location.pathname)} onSignOut={() => void auth.signOut()} />;
}

/** The sign-in control for deployment mode. Renders nothing in mock mode, which has no sign-in. */
export function SignInBar() {
  const [created] = useState<{ auth: BrowserAuth } | { problems: readonly string[] } | null>(() => {
    if (currentMode() !== "deployment") return null;
    try {
      return { auth: sharedAuth(undefined, logFault) };
    } catch (error) {
      if (error instanceof DeploymentConfigError) return { problems: error.problems };
      return { problems: [error instanceof Error ? error.message : "sign-in could not be set up"] };
    }
  });
  if (created === null) return null;
  return "auth" in created ? <Connected auth={created.auth} /> : <ConfigProblem problems={created.problems} />;
}
