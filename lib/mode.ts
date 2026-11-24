// The two ways this app runs. `mock` (the default) talks to the local NobleCloak mock on this machine and is what the
// sales demo has always been. `deployment` talks to a real NobleCloak deployment and the signed-in person's own token.
//
// One variable picks the mode: NEXT_PUBLIC_FERNHILL_MODE. It is NEXT_PUBLIC_ only because the browser needs the same
// answer and Next inlines that prefix at build time. Deployment mode never starts, calls or depends on the mock, and a
// deployment setting that is missing is an error that says so, never a quiet fall back to the mock.

export type Mode = "mock" | "deployment";

export class DeploymentConfigError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [message],
  ) {
    super(message);
    this.name = "DeploymentConfigError";
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Mock unless NEXT_PUBLIC_FERNHILL_MODE says `deployment`. Any other value is a mistake and is refused, not read as mock. */
export function modeOf(source: EnvSource): Mode {
  const value = (source.NEXT_PUBLIC_FERNHILL_MODE ?? "").trim();
  if (value === "" || value === "mock") return "mock";
  if (value === "deployment") return "deployment";
  throw new DeploymentConfigError(`NEXT_PUBLIC_FERNHILL_MODE is "mock" or "deployment" (or unset, which means mock), not "${value}".`);
}

/** The current mode. The variable is named in full so that Next can inline it into the browser bundle. */
export const currentMode = (): Mode => modeOf({ NEXT_PUBLIC_FERNHILL_MODE: process.env.NEXT_PUBLIC_FERNHILL_MODE });

/**
 * Refuses a build started as the other mode. `intended` is what the start script says (FERNHILL_RUN_MODE), `built` is
 * the mode inlined into this bundle. Nothing named means a bare `next start`, which has no intention to contradict.
 */
export function assertBuiltMode(intended: string | undefined, built: Mode): void {
  const want = (intended ?? "").trim();
  if (want === "" || want === built) return;
  const fix = built === "mock" ? "bun run build:deployment" : "bun run build";
  throw new DeploymentConfigError(`This build was built in ${built} mode but is being started as ${want}. Rebuild it for ${want} (${fix}) or start it as ${built}.`);
}

/** Throws in deployment mode. Put it first in anything that exists only to talk to the mock. */
export function assertMock(what: string, mode: Mode = currentMode()): void {
  if (mode !== "mock") throw new DeploymentConfigError(`${what} is mock only. Deployment mode never contacts the local mock.`);
}

/**
 * `https:`, or `http://localhost` on any port. The module applies this to the issuer and the `resource`; for the redirect
 * URI it requires only that it is on the page's own origin, and this app's config check holds it to the same rule.
 */
export function isSecureUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
}

const isOrigin = (value: string): boolean => URL.canParse(value) && new URL(value).origin === value;

export type DeploymentConfig = { apiUrl: string; issuer: string; clientId: string; redirectUri: string; scope?: string };
export type DeploymentConfigResult = { ok: true; config: DeploymentConfig } | { ok: false; problems: string[] };

/** What sign-in needs (every value is public: it reaches the browser). Says what is missing or malformed. */
export function parseDeploymentConfig(source: EnvSource): DeploymentConfigResult {
  const problems: string[] = [];
  const read = (name: string) => (source[name] ?? "").trim();

  const apiUrl = read("NEXT_PUBLIC_NC_API_URL");
  if (apiUrl === "") problems.push("NEXT_PUBLIC_NC_API_URL is not set (the deployment's API origin, for example https://govern.noblecloak.com)");
  else if (!isOrigin(apiUrl)) problems.push("NEXT_PUBLIC_NC_API_URL is an origin with no path or trailing slash");
  else if (!isSecureUrl(apiUrl)) problems.push("NEXT_PUBLIC_NC_API_URL uses https (or http://localhost)");

  const issuer = read("NEXT_PUBLIC_NC_ISSUER");
  if (issuer === "") problems.push("NEXT_PUBLIC_NC_ISSUER is not set (for example https://auth.noblecloak.com)");
  else if (!isSecureUrl(issuer)) problems.push("NEXT_PUBLIC_NC_ISSUER is an absolute URL that uses https (or http://localhost)");

  const clientId = read("NEXT_PUBLIC_NC_CLIENT_ID");
  if (clientId === "") problems.push("NEXT_PUBLIC_NC_CLIENT_ID is not set (the public client the operator registered)");
  else if (clientId === "REPLACE_ME") problems.push("NEXT_PUBLIC_NC_CLIENT_ID is still REPLACE_ME");

  const redirectUri = read("NEXT_PUBLIC_NC_REDIRECT_URI");
  if (redirectUri === "") problems.push("NEXT_PUBLIC_NC_REDIRECT_URI is not set (http://localhost:3417/auth/callback)");
  else if (!isSecureUrl(redirectUri)) problems.push("NEXT_PUBLIC_NC_REDIRECT_URI is an absolute URL that uses https (or http://localhost)");
  else if (/[?#*]/.test(redirectUri)) problems.push("NEXT_PUBLIC_NC_REDIRECT_URI is exact: no query, fragment or wildcard");

  if (problems.length > 0) return { ok: false, problems };
  const scope = read("NEXT_PUBLIC_NC_SCOPE");
  return { ok: true, config: { apiUrl, issuer, clientId, redirectUri, ...(scope ? { scope } : {}) } };
}

/** The sign-in configuration from the build's environment, or a thrown DeploymentConfigError naming every problem. */
export function deploymentConfig(): DeploymentConfig {
  const result = parseDeploymentConfig({
    NEXT_PUBLIC_NC_API_URL: process.env.NEXT_PUBLIC_NC_API_URL,
    NEXT_PUBLIC_NC_ISSUER: process.env.NEXT_PUBLIC_NC_ISSUER,
    NEXT_PUBLIC_NC_CLIENT_ID: process.env.NEXT_PUBLIC_NC_CLIENT_ID,
    NEXT_PUBLIC_NC_REDIRECT_URI: process.env.NEXT_PUBLIC_NC_REDIRECT_URI,
    NEXT_PUBLIC_NC_SCOPE: process.env.NEXT_PUBLIC_NC_SCOPE,
  });
  if (!result.ok) throw new DeploymentConfigError(`Deployment mode is not configured: ${result.problems.join("; ")}.`, result.problems);
  return result.config;
}

/** The mock's address when nothing says otherwise. Mock mode only. */
export const MOCK_BASE_URL = "http://127.0.0.1:8787";

/**
 * Where the server sends its requests. Mock: `deps.baseUrl`, NC_BASE_URL, then the mock's own address, as always.
 * Deployment: `deps.baseUrl` or NC_BASE_URL, which must be set, secure, and the same origin as NEXT_PUBLIC_NC_API_URL.
 * There is no default to fall back to.
 */
export function upstreamBase(deps: { baseUrl?: string; mode?: Mode } = {}): string {
  const mode = deps.mode ?? currentMode();
  if (mode === "mock") return (deps.baseUrl ?? process.env.NC_BASE_URL ?? MOCK_BASE_URL).replace(/\/+$/, "");
  const value = (deps.baseUrl ?? process.env.NC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (value === "") throw new DeploymentConfigError("Deployment mode needs NC_BASE_URL (the deployment's API origin, for example https://govern.noblecloak.com). It is not set.");
  if (!isSecureUrl(value)) throw new DeploymentConfigError("NC_BASE_URL uses https (or http://localhost) in deployment mode.");
  // The browser signs in against NEXT_PUBLIC_NC_API_URL and sends its token here, so this must be that same origin.
  const signedInFor = (process.env.NEXT_PUBLIC_NC_API_URL ?? "").trim().replace(/\/+$/, "");
  if (signedInFor === "") throw new DeploymentConfigError("Deployment mode needs NEXT_PUBLIC_NC_API_URL, and NC_BASE_URL must equal it. It is not set.");
  if (value !== signedInFor) throw new DeploymentConfigError(`NC_BASE_URL (${value}) must equal NEXT_PUBLIC_NC_API_URL (${signedInFor}) in deployment mode: people's tokens are sent only to the deployment they signed in for.`);
  return value;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** The bearer token on a request (the signed-in person's, attached by the browser), or null. */
export function bearerOf(headers: Pick<Headers, "get">): string | null {
  const match = BEARER.exec(headers.get("authorization") ?? "");
  return match ? match[1]! : null;
}

export const SIGN_IN_REQUIRED = { code: "sign_in_required", message: "Sign in to NobleCloak first. This app forwards your own token and holds none." } as const;

/** One body for a refusal that every client of the /api routes can read: `message` for the panels, `error` for the pollers. */
export const refusal = (status: number, message: string) => ({ ok: false as const, status, message, error: message });
