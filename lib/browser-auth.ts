import { createBrowserAuth, type BrowserAuth } from "@noblecloak/react/auth";
import { deploymentConfig, refusal, SIGN_IN_REQUIRED, type DeploymentConfig } from "./mode";

// Browser side of deployment mode. One sign-in object for the tab (the pages and the callback route are separate
// routes of one tab, and a second object over the same sessionStorage would be a second owner of one refresh token),
// and a fetch that attaches the signed-in person's access token to this app's own /api calls. The server forwards
// that header and holds no token of its own.

let shared: { key: string; auth: BrowserAuth } | undefined;

/** The tab's sign-in object. `resource` is the API's origin, so the access token's audience is the API. Throws a DeploymentConfigError when the build has no sign-in settings. */
export function sharedAuth(config: DeploymentConfig = deploymentConfig(), onFault?: (fault: unknown) => void): BrowserAuth {
  const key = JSON.stringify(config);
  if (shared?.key !== key) {
    shared = {
      key,
      auth: createBrowserAuth({
        issuer: config.issuer,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        resource: config.apiUrl,
        ...(config.scope ? { scope: config.scope } : {}),
        ...(onFault ? { onFault } : {}),
      }),
    };
  }
  return shared.auth;
}

/** Logs the fault's name and type only, never the object, which may carry a token or a response body. */
export function logFault(fault: unknown): void {
  console.error(`noblecloak fault: ${fault instanceof Error ? fault.name : "non-Error"} (${typeof fault})`);
}

/** The answer a signed-out call gets without any request leaving the browser: the same 401 the server gives. */
const signInRequired = () => new Response(JSON.stringify(refusal(401, SIGN_IN_REQUIRED.message)), { status: 401, headers: { "content-type": "application/json" } });

/**
 * A fetch that sends `Authorization: Bearer <token>` with each call. When there is no token (signed out, or sign-in
 * is not configured) the call is answered 401 locally, so the panels treat it like any refusal and keep what is on screen.
 */
export function bearerFetch(getToken: () => Promise<string>, doFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args)): typeof globalThis.fetch {
  return async (input, init) => {
    let token: string;
    try {
      token = await getToken();
    } catch {
      return signInRequired();
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return doFetch(input, { ...init, headers });
  };
}
