// Tests for the demo shim in noblecloak-local.ts. In-process: requests go to the app's fetch, no port is opened
// (3417 belongs to the dev server, 8787 to the real local mock).
import { loadServicePrincipalCredential, servicePrincipalTokenSource } from '@noblecloak/client/service-principal';
import { principalOfToken } from '@noblecloak/langgraph';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalMock, LOCAL_SERVICE_PRINCIPAL, TOKEN_PATH, writeLocalCredential, writeLocalEnv } from './noblecloak-local';

const BASE = 'http://127.0.0.1:8787';

type Local = Awaited<ReturnType<typeof createLocalMock>>;
let local: Local;
let tokens: Awaited<ReturnType<Local['mock']['tokens']>>;

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await local.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: r.status, body: (await r.json()) as any };
};

const REF = (n: string) => `ext:fernhill-desk:${n}`;
const registerTool = async (n: string) => {
  const r = await registerRaw(n);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};
const registerRaw = (n: string) =>
  call(tokens.creator, 'POST', '/v1/tools', { tool_ref: REF(n), description: n, input_schema: { type: 'object' }, side_effect_level: 'external', transport: 'external', owner_kind: 'org', show_arguments_to_approvers: true });
const publishRule = async (tool: string, mode: string) => {
  const created = await call(tokens.admin, 'POST', '/v1/policies', {
    kind: 'tool_invocation', name: `rule ${tool}`,
    subjects: [{ type: 'role', id: 'everyone' }], targets: { tools: [REF(tool)] }, config: { mode },
  });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  expect((await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`)).status).toBe(200);
  return id;
};
const editRule = async (id: string, tool: string, mode: string) => {
  const put = await call(tokens.admin, 'PUT', `/v1/policies/${id}`, {
    kind: 'tool_invocation', name: `rule ${tool}`,
    subjects: [{ type: 'role', id: 'everyone' }], targets: { tools: [REF(tool)] }, config: { mode },
  });
  expect(put.status).toBe(200);
  expect((await call(tokens.admin, 'POST', `/v1/policies/${id}/publish`)).status).toBe(200);
};
const decide = async (tool: string) => {
  const r = await call(tokens.creator, 'POST', '/v1/decisions', { action: { tool_ref: REF(tool), arguments: { n: 1 } }, actor: {} });
  expect(r.status).toBe(200);
  return r.body.data.decision as string;
};

beforeEach(async () => {
  local = await createLocalMock({ audience: 'http://127.0.0.1:8787' });
  tokens = await local.mock.tokens();
});

describe('published rules decide outcomes', () => {
  it('always_allow gives allow', async () => {
    await registerTool('slack_invite');
    await publishRule('slack_invite', 'always_allow');
    expect(await decide('slack_invite')).toBe('allow');
  });

  it('ask gives step_up', async () => {
    await registerTool('adp_create_employee');
    await publishRule('adp_create_employee', 'ask');
    expect(await decide('adp_create_employee')).toBe('step_up');
  });

  it('deny gives deny', async () => {
    await registerTool('okta_assign_admin_role');
    await publishRule('okta_assign_admin_role', 'deny');
    expect(await decide('okta_assign_admin_role')).toBe('deny');
  });

  it('editing a published rule changes the next decision, in both directions', async () => {
    await registerTool('mercury_issue_card');
    const id = await publishRule('mercury_issue_card', 'ask');
    expect(await decide('mercury_issue_card')).toBe('step_up');
    await editRule(id, 'mercury_issue_card', 'always_allow');
    expect(await decide('mercury_issue_card')).toBe('allow');
    await editRule(id, 'mercury_issue_card', 'deny');
    expect(await decide('mercury_issue_card')).toBe('deny');
  });

  it('a saved but unpublished edit does not change the decision', async () => {
    await registerTool('cdw_order_laptop');
    const id = await publishRule('cdw_order_laptop', 'always_allow');
    await call(tokens.admin, 'PUT', `/v1/policies/${id}`, {
      kind: 'tool_invocation', name: 'x', subjects: [{ type: 'role', id: 'everyone' }], targets: { tools: [REF('cdw_order_laptop')] }, config: { mode: 'deny' },
    });
    expect(await decide('cdw_order_laptop')).toBe('allow');
  });

  it('a retired rule stops applying and the tool falls back to ask', async () => {
    await registerTool('merch_order_polos');
    const id = await publishRule('merch_order_polos', 'always_allow');
    expect(await decide('merch_order_polos')).toBe('allow');
    expect((await call(tokens.admin, 'POST', `/v1/policies/${id}/retire`)).status).toBe(200);
    expect(await decide('merch_order_polos')).toBe('step_up');
  });

  it('a tool with no policy stays ask', async () => {
    await registerTool('print_order_business_cards');
    expect(await decide('print_order_business_cards')).toBe('step_up');
  });

  it('a rule for one tool does not change another', async () => {
    await registerTool('okta_create_user');
    await registerTool('google_create_account');
    await publishRule('okta_create_user', 'always_allow');
    expect(await decide('okta_create_user')).toBe('allow');
    expect(await decide('google_create_account')).toBe('step_up');
  });
});

describe('which rules count', () => {
  // The API refuses a second published rule over the same (tool, subject) (409 policy_conflict), so overlapping
  // rules are built by cloning a published one inside the mock's state.
  const cloneRule = (fromId: string, patch: { mode?: string; tools?: 'all' | string[]; subjects?: { type: string; id: string }[]; org?: string; published?: boolean }) => {
    const { state } = local.mock;
    const row = state.policies.get(fromId)!;
    const [version] = state.policyVersions.get(fromId)!;
    const id = `pol_clone_${Math.random().toString(36).slice(2, 8)}`;
    state.policies.set(id, { ...row, id, ...(patch.org ? { org: patch.org } : {}) });
    state.policyVersions.set(id, [
      {
        ...version!,
        targets: { tools: patch.tools ?? version!.targets.tools },
        subjects: patch.subjects ?? version!.subjects,
        config: { mode: patch.mode ?? version!.config.mode },
        published_at: patch.published === false ? null : version!.published_at,
      },
    ]);
    return id;
  };

  it('tightest wins when two published rules cover one tool, in either creation order', async () => {
    for (const [first, second] of [['always_allow', 'ask'], ['ask', 'always_allow']] as const) {
      local = await createLocalMock({ audience: 'http://127.0.0.1:8787' });
      tokens = await local.mock.tokens();
      await registerTool('slack_invite');
      const specific = await publishRule('slack_invite', first);
      cloneRule(specific, { mode: second, tools: 'all' });
      expect(await decide('slack_invite')).toBe('step_up');
    }
  });

  it('tightest wins down to deny', async () => {
    await registerTool('slack_invite');
    const id = await publishRule('slack_invite', 'always_allow');
    cloneRule(id, { mode: 'deny', tools: 'all' });
    expect(await decide('slack_invite')).toBe('deny');
  });

  it('a rule for a subject other than everyone does not apply', async () => {
    await registerTool('slack_invite');
    const id = await publishRule('slack_invite', 'ask');
    local.mock.state.policyVersions.get(id)![0]!.subjects = [{ type: 'role', id: 'member' }];
    local.mock.state.policyVersions.get(id)![0]!.config = { mode: 'deny' };
    expect(await decide('slack_invite')).toBe('step_up');
    local.mock.state.policyVersions.get(id)![0]!.subjects = [{ type: 'role', id: 'everyone' }];
    expect(await decide('slack_invite')).toBe('deny');
  });

  it('a rule from another organisation does not apply', async () => {
    await registerTool('slack_invite');
    const id = await publishRule('slack_invite', 'always_allow');
    expect(await decide('slack_invite')).toBe('allow');
    local.mock.state.policies.get(id)!.org = 'org_other';
    expect(await decide('slack_invite')).toBe('step_up');
  });

  it('a policy that was never published does not apply', async () => {
    await registerTool('slack_invite');
    const created = await call(tokens.admin, 'POST', '/v1/policies', {
      kind: 'tool_invocation', name: 'draft only',
      subjects: [{ type: 'role', id: 'everyone' }], targets: { tools: [REF('slack_invite')] }, config: { mode: 'always_allow' },
    });
    expect(created.status).toBe(201);
    expect(await decide('slack_invite')).toBe('step_up');
  });
});

describe('GET /__demo/token (server to server)', () => {
  const get = (path: string, headers: Record<string, string> = {}) =>
    local.fetch(new Request(`http://127.0.0.1:8787${path}`, { headers }));

  it('mints a token for Priya and for Sam that the mock accepts as those users', async () => {
    await registerTool('mercury_issue_card');
    for (const [who, sub, name] of [['priya', 'user_priya_shah', 'Priya Shah'], ['sam', 'user_sam_okoye', 'Sam Okoye']] as const) {
      const r = await get(`/__demo/token?as=${who}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { token: string; sub: string };
      expect(body.sub).toBe(sub);
      // The token works on the real routes, and the mock names the user from it.
      const d = await call(tokens.creator, 'POST', '/v1/decisions', { action: { tool_ref: REF('mercury_issue_card'), arguments: { n: who } }, actor: {} });
      const approval = d.body.data.approval as { id: string };
      const digest = d.body.data.action_digest as string;
      const resolved = await call(body.token, 'POST', `/v1/approvals/${approval.id}/resolve`, { resolution: 'approved', expected_action_digest: digest });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.data.resolution_history[0].by).toEqual({ id: sub, kind: 'user', display_name: name });
    }
  });

  it('refuses a browser request (Origin or Sec-Fetch-Site) so no token is handed to a page', async () => {
    expect((await get('/__demo/token?as=priya', { origin: 'http://127.0.0.1:3417' })).status).toBe(403);
    expect((await get('/__demo/token?as=priya', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
  });

  it('refuses an unknown persona and any method but GET', async () => {
    expect((await get('/__demo/token?as=admin')).status).toBe(400);
    expect((await get('/__demo/token')).status).toBe(400);
    const post = await local.fetch(new Request('http://127.0.0.1:8787/__demo/token?as=priya', { method: 'POST' }));
    expect(post.status).toBe(405);
  });
});

describe('who approves: payroll goes to HR and the card to Finance', () => {
  const tokenOf = async (who: 'priya' | 'sam') =>
    ((await (await local.fetch(new Request(`http://127.0.0.1:8787/__demo/token?as=${who}`))).json()) as { token: string }).token;
  const open = async (tool: string, args: Record<string, unknown> = { employee: 'Maya Torres' }) => {
    const d = await call(tokens.creator, 'POST', '/v1/decisions', { action: { tool_ref: REF(tool), arguments: args }, actor: {} });
    expect(d.body.data.decision, JSON.stringify(d.body)).toBe('step_up');
    return { id: d.body.data.approval.id as string, digest: d.body.data.action_digest as string };
  };
  const resolve = (token: string, a: { id: string; digest: string }, resolution = 'approved') =>
    call(token, 'POST', `/v1/approvals/${a.id}/resolve`, { resolution, expected_action_digest: a.digest });

  it.each([
    ['adp_create_employee', 'priya', 'sam', 'hr'],
    ['mercury_issue_card', 'sam', 'priya', 'finance'],
  ] as const)('%s: %s is refused and sees no arguments; %s decides', async (tool, outsider, approver, role) => {
    await registerTool(tool);
    await publishRule(tool, 'ask');
    const a = await open(tool);
    const [out, inn] = [await tokenOf(outsider), await tokenOf(approver)];

    const seen = await call(out, 'GET', `/v1/approvals/${a.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.arguments).toBeUndefined();
    expect(seen.body.data.arguments_state).toBe('withheld');
    expect(seen.body.data.requirements[0].approvers).toEqual([{ role }]);
    const refused = await resolve(out, a);
    expect(refused.status).toBe(403);
    expect(refused.body.type).toContain('not_eligible');
    // A refusal decides nothing, in either direction.
    expect((await resolve(out, a, 'rejected')).status).toBe(403);
    expect((await call(inn, 'GET', `/v1/approvals/${a.id}`)).body.data.state).toBe('pending');

    const mine = await call(inn, 'GET', `/v1/approvals/${a.id}`);
    expect(mine.body.data.arguments).toEqual({ employee: 'Maya Torres' });
    expect(mine.body.data.arguments_state).toBe('shown');
    const done = await resolve(inn, a);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.state).toBe('approved');
  });

  it('a tool with no team stays open to either approver when its rule asks', async () => {
    await registerTool('slack_invite');
    await publishRule('slack_invite', 'ask');
    for (const who of ['priya', 'sam'] as const) {
      const a = await open('slack_invite', { invited_by: who });
      expect((await resolve(await tokenOf(who), a)).status).toBe(200);
    }
  });

  it('a rule that already names its approvers is left as it is', async () => {
    await registerTool('adp_create_employee');
    const created = await call(tokens.admin, 'POST', '/v1/policies', {
      kind: 'tool_invocation', name: 'payroll, by finance',
      subjects: [{ type: 'role', id: 'everyone' }], targets: { tools: [REF('adp_create_employee')] }, config: { mode: 'ask', approvers: [{ role: 'finance' }] },
    });
    expect((await call(tokens.admin, 'POST', `/v1/policies/${created.body.data.id as string}/publish`)).status).toBe(200);
    const a = await open('adp_create_employee');
    expect((await resolve(await tokenOf('sam'), a)).status).toBe(403);
    expect((await resolve(await tokenOf('priya'), a)).status).toBe(200);
  });

  it('names approvers only on a rule that asks', async () => {
    await registerTool('mercury_issue_card');
    const id = await publishRule('mercury_issue_card', 'always_allow');
    expect(await decide('mercury_issue_card')).toBe('allow');
    expect((await call(tokens.admin, 'GET', `/v1/policies/${id}`)).body.data.config).toEqual({ mode: 'always_allow' });
  });
});

describe('/__mock/* is for server-side callers only', () => {
  const req = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    local.fetch(new Request(`http://127.0.0.1:8787${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const BROWSER = { origin: 'http://127.0.0.1:3417' };

  it('refuses a request that carries Origin or Sec-Fetch-Site, on tokens and advance', async () => {
    for (const [method, path, body] of [['GET', '/__mock/tokens', undefined], ['POST', '/__mock/advance', { seconds: 1 }]] as const) {
      expect((await req(method, path, BROWSER, body)).status, `${method} ${path} origin`).toBe(403);
      expect((await req(method, path, { 'sec-fetch-site': 'same-site' }, body)).status, `${method} ${path} sfs`).toBe(403);
    }
  });

  it('refuses a CORS preflight too, so the browser never gets the allow headers', async () => {
    const r = await req('OPTIONS', '/__mock/tokens', { ...BROWSER, 'access-control-request-method': 'GET' });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still answers a server-side caller (no Origin), as the app server does', async () => {
    const t = await req('GET', '/__mock/tokens');
    expect(t.status).toBe(200);
    expect(Object.keys((await t.json()) as object).length).toBeGreaterThan(5);
    expect((await req('POST', '/__mock/advance', {}, { seconds: 1 })).status).toBe(200);
  });

  it('leaves the /v1 API on its own CORS rules', async () => {
    const r = await req('OPTIONS', '/v1/approvals', { ...BROWSER, 'access-control-request-method': 'GET' });
    expect(r.status).not.toBe(403);
  });
});

describe("the service principal's token endpoint", () => {
  const tokenRequest = (over: { assertion?: string; origin?: string; method?: string } = {}) =>
    new Request(`${BASE}${TOKEN_PATH}`, {
      method: over.method ?? "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(over.origin ? { origin: over.origin } : {}) },
      body:
        over.method === "GET"
          ? undefined
          : new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: over.assertion ?? "a.b.c" }).toString(),
    });

  it("lets the generated governance run UNEDITED: the template's own credential load and token source get a svc_adapter token", async () => {
    const local = await createLocalMock({ audience: BASE });
    const dir = mkdtempSync(join(tmpdir(), "fernhill-cred-"));
    const file = join(dir, "sp.credentials.json");
    await writeLocalCredential(file, BASE);
    const credential = await loadServicePrincipalCredential(file);
    const source = servicePrincipalTokenSource(credential, { audience: BASE, fetch: ((input: RequestInfo | URL, init?: RequestInit) => local.fetch(new Request(input, init))) as typeof fetch });
    const token = await source.getToken();
    expect(principalOfToken(token)).toBe(LOCAL_SERVICE_PRINCIPAL);
    // ES256 signatures differ per signing, so compare by use: the mock accepts it as the service principal.
    expect((await local.fetch(new Request(`${BASE}/v1/capabilities`, { headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
    expect(statSync(file).mode & 0o077).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers with a positive lifetime the client accepts", async () => {
    const { fetch } = await createLocalMock({ audience: BASE });
    const res = await fetch(tokenRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token_type: "Bearer", expires_in: expect.any(Number) });
  });

  it("refuses a request with no assertion, as an OAuth error", async () => {
    const { fetch } = await createLocalMock({ audience: BASE });
    const res = await fetch(new Request(`${BASE}${TOKEN_PATH}`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials" }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("is POST only and refuses a browser page", async () => {
    const { fetch } = await createLocalMock({ audience: BASE });
    expect((await fetch(tokenRequest({ method: "GET" }))).status).toBe(405);
    expect((await fetch(tokenRequest({ origin: "http://evil.example" }))).status).toBe(403);
  });
});

describe("the local setup files", () => {
  it("writes .env.local with the mock's URL, the credential path and the principal, keeping one that already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "fernhill-env-"));
    const file = join(dir, ".env.local");
    writeLocalEnv(file);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("NC_BASE_URL=http://127.0.0.1:8787");
    expect(text).toContain("NOBLECLOAK_SP_CREDENTIALS=.data/noblecloak-sp.credentials.json");
    expect(text).toContain("NC_EXPECTED_PRINCIPAL=svc_adapter");
    expect(text).not.toContain("NC_TOKEN");
    writeFileSync(file, "MINE=1\n");
    writeLocalEnv(file);
    expect(readFileSync(file, "utf8")).toBe("MINE=1\n");
    rmSync(dir, { recursive: true, force: true });
  });
});
