import { ApprovalsError, type Deps } from "./approvals";
import { bearerOf, currentMode, DeploymentConfigError, refusal, SIGN_IN_REQUIRED } from "./mode";

// What the /api/approvals, /api/proposal and /api/persona routes share about who is calling.
// Mock mode: nothing is asked of the caller (the server holds the mock's tokens). Deployment mode: the caller's own
// bearer token is required and is the only credential used; a request without one is answered 401 here, before any
// request leaves this app.

export type CallerDeps = { ok: true; deps: Deps } | { ok: false; status: 401; body: ReturnType<typeof refusal> };

/** The deps to hand to lib/approvals and lib/proposal for this request. */
export function callerDeps(request: Request): CallerDeps {
  if (currentMode() !== "deployment") return { ok: true, deps: {} };
  const bearer = bearerOf(request.headers);
  if (bearer === null) return { ok: false, status: 401, body: refusal(401, SIGN_IN_REQUIRED.message) };
  return { ok: true, deps: { bearer, mode: "deployment" } };
}

/**
 * The status a failure is answered with. Deployment mode: a refused token passes through (so the page can ask for a
 * sign-in) and a missing setting is ours (500). Mock mode answers `fallback` for everything, as it always has.
 */
export function statusOf(error: unknown, fallback: number): number {
  if (currentMode() !== "deployment") return fallback;
  if (error instanceof ApprovalsError && (error.status === 401 || error.status === 403)) return error.status;
  if (error instanceof DeploymentConfigError) return 500;
  return fallback;
}
