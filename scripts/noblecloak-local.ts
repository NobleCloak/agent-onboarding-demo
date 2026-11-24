// Local NobleCloak for the Fernhill Desk demo: `bun run noblecloak`. LOCAL ONLY, no account, no network.
//
// THIS IS A DEMO SHIM OVER @noblecloak/spec's MOCK. IT IS NOT NOBLECLOAK'S POLICY ENGINE. The mock decides every
// call from the mode on the tool's own row (`tool.mode`) and ignores published policies. Registered tools start
// at `ask`. So before each request this file copies the mode of the published `tool_invocation` policy for the
// role `everyone` onto the matching `ext:` tool rows. That makes saved rules, and later edits to them, decide
// outcomes on screen. Real NobleCloak resolves policy itself and does not work this way; do not read this
// file as evidence of how it behaves. It uses only the package's public exports (`createMock`, `Mock.state`).
//
// WHO APPROVES: Fernhill sends payroll to HR and company cards to Finance (lib/approver-routing.ts). A setup proposal
// carries a mode for each rule and nothing else, so the approved rules arrive with no approvers named. This file adds
// them: before each request it names the team's role as the approver on the published `ask` rule of those two tools,
// and it gives Priya's and Sam's tokens their team's role. From there the mock does the rest by itself, as the
// NobleCloak API describes: only a holder of that role may decide the approval (anyone else gets 403 `not_eligible`)
// and nobody else is shown its arguments. In a real deployment an administrator names the approvers on the policy.
//
// TOKEN ENDPOINT: the mock has none, and the setup skill's generated `governance.ts` signs an assertion and posts it to
// the `token_endpoint` in its credential file. So this shim serves `POST /oauth/token` and writes a matching
// credential file on start, and the generated files run unedited. It DOES NOT VERIFY THE ASSERTION: it hands the mock's
// `creator` token (service principal `svc_adapter`) to any request that carries one. That is fine for a local demo on
// 127.0.0.1 and is exactly what a real token endpoint must never do.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMock } from '@noblecloak/spec';
import type { Mock } from '@noblecloak/spec';
import { CREDENTIAL_PATH, SERVICE_PRINCIPAL, writeEnvLocalIfMissing } from './demo-config';
import { APPROVER_TEAM, PERSONA_TEAM } from '../lib/approver-routing';
import { modeOf, tighterOf, type Mode } from './rule-modes';

export const LOCAL_HOST = '127.0.0.1';
// The demo uses 8787. NC_LOCAL_PORT lets tests and rehearsals run another mock beside it.
export const LOCAL_PORT = Number(process.env.NC_LOCAL_PORT ?? 8787);
export const BASE_URL = `http://${LOCAL_HOST}:${String(LOCAL_PORT)}`;
// FERNHILL_APP_PORT moves the app (the launcher sets it) so a rehearsal can run beside the real demo.
export const APP_ORIGIN = `http://127.0.0.1:${process.env.FERNHILL_APP_PORT ?? 3417}`;


const covers = (targets: { tools: 'all' | string[] }, toolRef: string) => targets.tools === 'all' || targets.tools.includes(toolRef);

/**
 * Set `mode` on every registered `ext:` tool row from the published `everyone` rules of its organisation.
 * A tool with no published rule gets `ask`, which is also what registration gives it. Seeded mock tools
 * (`mcp:`) are left alone.
 */
export function syncModesFromPolicies(mock: Pick<Mock, 'state'>): void {
  const { state } = mock;
  for (const tool of state.tools.values()) {
    if (!tool.tool_ref.startsWith('ext:')) continue;
    let tightest: Mode | undefined;
    for (const [id, versions] of state.policyVersions) {
      if (state.policies.get(id)?.org !== tool.org) continue;
      const inForce = [...versions].reverse().find((v) => v.published_at !== null);
      if (inForce === undefined || inForce.retired_at !== undefined || inForce.kind !== 'tool_invocation') continue;
      if (!inForce.subjects.some((s) => s.type === 'role' && s.id === 'everyone')) continue;
      if (!covers(inForce.targets, tool.tool_ref)) continue;
      tightest = tighterOf(tightest, modeOf(inForce.config.mode));
    }
    tool.mode = tightest ?? 'ask';
  }
}

const TOOL_PREFIX = 'ext:fernhill-desk:';
/** The role that decides each routed tool, by `tool_ref`. */
const APPROVER_ROLE = new Map(Object.entries(APPROVER_TEAM).map(([tool, team]) => [`${TOOL_PREFIX}${tool}`, team]));

/**
 * Name Fernhill's approvers on the published `everyone` rule of each routed tool, when that rule asks and names none.
 * A rule that already names approvers, or has rules of its own, is somebody's own edit and is left alone. See the header.
 */
export function applyApproverRouting(mock: Pick<Mock, 'state'>): void {
  const { state } = mock;
  for (const versions of state.policyVersions.values()) {
    const inForce = [...versions].reverse().find((v) => v.published_at !== null);
    if (inForce === undefined || inForce.retired_at !== undefined || inForce.kind !== 'tool_invocation') continue;
    if (!inForce.subjects.some((s) => s.type === 'role' && s.id === 'everyone')) continue;
    const tools = inForce.targets.tools;
    if (tools === 'all' || tools.length !== 1) continue;
    const role = APPROVER_ROLE.get(tools[0]!);
    const config = inForce.config as { mode?: unknown; approvers?: unknown; rules?: unknown };
    if (role === undefined || config.mode !== 'ask' || config.approvers !== undefined || config.rules !== undefined) continue;
    config.approvers = [{ role }];
  }
}

/** The demo approvers. The mock names a user from the token's `sub`, so these show as "Priya Shah" and "Sam Okoye". */
export const DEMO_APPROVERS = { priya: 'user_priya_shah', sam: 'user_sam_okoye' } as const;
export const DEMO_TOKEN_PATH = '/__demo/token';

export const TOKEN_PATH = '/oauth/token';
/** The id the mock's `creator` token carries, which is what the agent and the worker run as. */
export const LOCAL_SERVICE_PRINCIPAL = SERVICE_PRINCIPAL;
export const LOCAL_CREDENTIAL_PATH = CREDENTIAL_PATH;

/** Write a credential file in the shape `loadServicePrincipalCredential` reads. The key signs nothing that is checked. */
export async function writeLocalCredential(file: string, baseUrl: string): Promise<void> {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const credential = {
    client_id: `sp_${randomUUID()}`,
    token_endpoint: `${baseUrl}${TOKEN_PATH}`,
    assertion_audience: baseUrl,
    private_jwk: await crypto.subtle.exportKey('jwk', privateKey),
    org_id: 'org_mock',
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
}

/** What the agent and the worker read. Git-ignored. An existing file is left alone: it may be someone's own. */
export function writeLocalEnv(file: string): void {
  writeEnvLocalIfMissing(file, `http://${LOCAL_HOST}:8787`);
}

const expiresIn = (jwt: string): number => {
  const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as { exp?: number };
  return Math.max(60, (exp ?? 0) - Math.floor(Date.now() / 1000));
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function createLocalMock(opts: { audience?: string; origins?: string[] } = {}) {
  const audience = opts.audience ?? BASE_URL;
  const mock = await createMock({
    audience,
    allowedOrigins: opts.origins ?? [APP_ORIGIN],
    control: true,
  });
  // GET /__demo/token?as=priya|sam. For the app's own server only: a request that carries an Origin or a
  // Sec-Fetch-Site header comes from a browser page and is refused, so a token never reaches the browser from here.
  const demoToken = async (request: Request, url: URL) => {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.has('origin') || request.headers.has('sec-fetch-site')) return json({ error: 'server_to_server_only' }, 403);
    const who = url.searchParams.get('as');
    if (who !== 'priya' && who !== 'sam') return json({ error: 'unknown_persona', allowed: Object.keys(DEMO_APPROVERS) }, 400);
    const token = await mock.issuer.mint({
      sub: DEMO_APPROVERS[who],
      org: 'org_mock',
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 3600,
      principal_kind: 'user',
      // The team's role is what makes this person an approver of that team's requests (see the header).
      scope: `approvals:resolve role:${PERSONA_TEAM[who]}`,
    });
    return json({ token, sub: DEMO_APPROVERS[who] }, 200);
  };
  // POST /oauth/token. See the header: any assertion gets the `creator` token, because this is a local demo.
  const spToken = async (request: Request) => {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.has('origin') || request.headers.has('sec-fetch-site')) return json({ error: 'server_to_server_only' }, 403);
    const form = new URLSearchParams(await request.text());
    if (!form.get('client_assertion')) return json({ error: 'invalid_request', error_description: 'client_assertion is required' }, 400);
    const { creator } = await mock.tokens();
    return json({ access_token: creator, token_type: 'Bearer', expires_in: expiresIn(creator) }, 200);
  };
  const fetchSynced = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === DEMO_TOKEN_PATH) return demoToken(request, url);
    if (url.pathname === TOKEN_PATH) return spToken(request);
    // /__mock/* hands out every token and moves the clock. Only a server-side caller may use it, so a request
    // from a browser page (Origin or Sec-Fetch-Site, preflights included) is refused before the mock sees it.
    if (url.pathname.startsWith('/__mock/') && (request.headers.has('origin') || request.headers.has('sec-fetch-site'))) {
      return json({ error: 'server_to_server_only' }, 403);
    }
    syncModesFromPolicies(mock);
    applyApproverRouting(mock);
    return mock.app.fetch(request);
  };
  return { mock, fetch: fetchSynced };
}

if (import.meta.main) {
  const { mock, fetch } = await createLocalMock();
  // The demo's own mock writes the setup files in place. A mock on another port (tests) writes a credential only when
  // told where, so it can never point the demo's agent at the wrong mock.
  const credentialFile = process.env.NC_LOCAL_CREDENTIAL_FILE ?? (process.env.NC_LOCAL_PORT === undefined ? LOCAL_CREDENTIAL_PATH : undefined);
  if (credentialFile !== undefined) await writeLocalCredential(credentialFile, BASE_URL);
  if (process.env.NC_LOCAL_PORT === undefined) writeLocalEnv('.env.local');
  const bun = (globalThis as unknown as { Bun: { serve(o: { hostname: string; port: number; idleTimeout: number; fetch: (r: Request) => Response | Promise<Response> }): unknown } }).Bun;
  // Bun closes a connection idle for 10 s by default, which cuts the worker's approval stream: `worker_error unreachable` every 12 s, with a gap until it reconnects.
  bun.serve({ hostname: LOCAL_HOST, port: LOCAL_PORT, idleTimeout: 0, fetch });
  console.log(`NobleCloak LOCAL mock (demo shim, not the real service): ${BASE_URL}`);
  if (credentialFile !== undefined) console.log(`Service principal ${LOCAL_SERVICE_PRINCIPAL}, credential: ${credentialFile}`);
  console.log(`Admits browser origin ${APP_ORIGIN}. In-memory: stopping it wipes all state. Tokens: GET ${BASE_URL}/__mock/tokens. Approver tokens (server only): GET ${BASE_URL}${DEMO_TOKEN_PATH}?as=priya|sam`);
  void mock;
}
