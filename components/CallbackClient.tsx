"use client";

import { useAuthState } from "@noblecloak/react/auth";
import type { BrowserAuth } from "@noblecloak/react/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { logFault, sharedAuth } from "../lib/browser-auth";
import { DeploymentConfigError } from "../lib/mode";
import { ConfigProblem } from "./ConfigProblem";

/**
 * The redirect target of the authorization request. It completes the sign-in once (the module takes the code out of
 * the address first) and goes on to the page the person started from only when that worked. A denial or a failure
 * stays here and says so; nothing on this page signs anyone in.
 */
export function CallbackClient({ auth: given }: { auth?: BrowserAuth }) {
  const [created] = useState<{ auth: BrowserAuth } | { problems: readonly string[] }>(() => {
    if (given) return { auth: given };
    try {
      return { auth: sharedAuth(undefined, logFault) };
    } catch (error) {
      return { problems: error instanceof DeploymentConfigError ? error.problems : [error instanceof Error ? error.message : "sign-in could not be set up"] };
    }
  });
  return "auth" in created ? <Completing auth={created.auth} /> : <ConfigProblem problems={created.problems} />;
}

export type CallbackViewProps = { status: "denied" | "error" | "working"; message?: string };

export function CallbackView({ status, message }: CallbackViewProps) {
  if (status === "denied") {
    return (
      <p role="alert">
        Access was not granted. <Link href="/">Back to Fernhill Desk</Link> to try again.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p role="alert">
        Sign-in failed: {message} <Link href="/">Back to Fernhill Desk</Link> to try again.
      </p>
    );
  }
  return <p role="status">Signing in.</p>;
}

function Completing({ auth }: { auth: BrowserAuth }) {
  const state = useAuthState(auth);
  const router = useRouter();
  useEffect(() => {
    void auth.completeSignIn();
  }, [auth]);
  const returnTo = state.status === "signed_in" ? (state.returnTo ?? "/") : undefined;
  useEffect(() => {
    if (returnTo !== undefined) router.replace(returnTo);
  }, [returnTo, router]);
  if (state.status === "denied") return <CallbackView status="denied" />;
  if (state.status === "error") return <CallbackView status="error" message={state.error.message} />;
  return <CallbackView status="working" />;
}
