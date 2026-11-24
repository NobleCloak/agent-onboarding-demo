"use client";

import { useAuthState } from "@noblecloak/react/auth";
import type { BrowserAuth } from "@noblecloak/react/auth";
import { useEffect, useState, type ReactNode } from "react";
import { bearerFetch, logFault, sharedAuth } from "../lib/browser-auth";
import { DeploymentConfigError } from "../lib/mode";
import { hasFernhillTools } from "../lib/fernhill-tools";
import { ConfigProblem } from "./ConfigProblem";
import { PermissionsModule } from "./PermissionsModule";

export type PermissionsAnswer = "checking" | "registered" | "none" | "signed_out" | { error: string };

/** What the page shows for a `GET /v1/tools` answer through /api/nc. Pure, so it is tested without a browser. */
export async function answerOf(res: Response): Promise<PermissionsAnswer> {
  if (res.status === 401) return "signed_out";
  if (!res.ok) return { error: `NobleCloak answered HTTP ${res.status}.` };
  return hasFernhillTools(await res.json().catch(() => null)) ? "registered" : "none";
}

export type DeploymentPermissionsViewProps = { answer: PermissionsAnswer; stub: ReactNode };

/**
 * Mock mode asks the server whether Fernhill's tools are registered. A deployment's server holds no token, so this asks
 * with the signed-in person's own: the module once the tools are registered (the rules were approved), the stub before
 * that, and a plain prompt while the answer is not known (signed out, checking or failed). A failed read is not "none".
 */
export function DeploymentPermissionsView({ answer, stub }: DeploymentPermissionsViewProps) {
  if (answer === "registered") return <PermissionsModule />;
  if (answer === "none") return <>{stub}</>;
  if (answer === "checking") return <p className="note" data-testid="permissions-checking">Checking which tools are registered.</p>;
  if (answer === "signed_out") return <p className="note" role="status" data-testid="permissions-sign-in">Sign in to NobleCloak to see this organisation&apos;s rules.</p>;
  return <p className="note" role="alert" data-testid="permissions-error">Could not read the rules. {answer.error}</p>;
}

function Asking({ auth, stub }: { auth: BrowserAuth; stub: ReactNode }) {
  const state = useAuthState(auth);
  const [answer, setAnswer] = useState<PermissionsAnswer>("checking");
  const signedIn = state.status === "signed_in";
  useEffect(() => {
    if (!signedIn) return setAnswer("signed_out");
    let live = true;
    setAnswer("checking");
    bearerFetch(() => auth.getToken())("/api/nc/v1/tools?limit=200", { cache: "no-store" })
      .then(answerOf, (e: unknown) => ({ error: e instanceof Error ? e.message : "request failed" }))
      .then((next) => live && setAnswer(next));
    return () => {
      live = false;
    };
  }, [auth, signedIn]);
  return <DeploymentPermissionsView answer={answer} stub={stub} />;
}

export function DeploymentPermissions({ stub }: { stub: ReactNode }) {
  const [created] = useState<{ auth: BrowserAuth } | { problems: readonly string[] }>(() => {
    try {
      return { auth: sharedAuth(undefined, logFault) };
    } catch (error) {
      return { problems: error instanceof DeploymentConfigError ? error.problems : [error instanceof Error ? error.message : "sign-in could not be set up"] };
    }
  });
  return "auth" in created ? <Asking auth={created.auth} stub={stub} /> : <ConfigProblem problems={created.problems} />;
}
