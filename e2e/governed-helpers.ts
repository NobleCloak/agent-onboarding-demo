import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { E2E_CREDENTIAL_FILE, E2E_MOCK_PORT } from "../playwright.config";

export const MOCK = `http://127.0.0.1:${E2E_MOCK_PORT}`;
const REF_PREFIX = "ext:fernhill-desk:";

const waitForLine = (child: ChildProcess, marker: string, what: string) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not start`)), 30_000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`${what} exited with ${code}`)));
  });

/** A fresh local NobleCloak: empty state, new keys, and a credential the agent and the worker read. */
export async function startMock(): Promise<ChildProcess> {
  const mock = spawn("bun", ["scripts/noblecloak-local.ts"], {
    env: { ...process.env, NC_LOCAL_PORT: String(E2E_MOCK_PORT), NC_LOCAL_CREDENTIAL_FILE: E2E_CREDENTIAL_FILE },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitForLine(mock, "Tokens:", "the mock");
  return mock;
}

/** The generated worker, unedited, the way the findings doc says to run it. */
export async function startWorker(): Promise<ChildProcess> {
  const worker = spawn("node", ["--import", "tsx", "src/noblecloak/worker.ts"], {
    env: { ...process.env, NC_BASE_URL: MOCK, NOBLECLOAK_SP_CREDENTIALS: E2E_CREDENTIAL_FILE, NC_EXPECTED_PRINCIPAL: "svc_adapter" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitForLine(worker, "worker_ready", "the worker");
  return worker;
}

export const stop = (child: ChildProcess | undefined) =>
  new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.removeAllListeners("exit");
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

export async function tokens(): Promise<Record<string, string>> {
  return (await (await fetch(`${MOCK}/__mock/tokens`)).json()) as Record<string, string>;
}

export async function nc(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(MOCK + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

/** Open the rule proposal from demo/rules.plan.json, as `propose.mjs` does on a real install: a person declares and proposes. */
export async function proposeRules(): Promise<string> {
  const plan = JSON.parse(readFileSync(process.env.FERNHILL_E2E_PLAN ?? "demo/rules.plan.json", "utf8"));
  const { creator_user: person } = await tokens();
  const agent = await nc(person, "POST", "/v1/agents", { name: "Fernhill Desk" }, { "idempotency-key": crypto.randomUUID() });
  const opened = await nc(person, "POST", "/v1/approvals", {
    action: {
      tool_ref: "tool:noblecloak:propose-policy-set",
      arguments: {
        agent: { id: agent.body.data.id, principal_id: "svc_adapter" },
        tools: plan.tools.map((t: object) => ({ owner_kind: "org", transport: "external", ...t })),
        policies: plan.policies.map((p: any) => ({ role: p.role, rationale: p.rationale, assessment: p.assessment, policy: { kind: "tool_invocation", subjects: [{ type: "role", id: "everyone" }], targets: { tools: [p.tool] }, config: { mode: p.mode } } })),
      },
    },
    continuation: { kind: "mcp_held", delivery: "held" },
  });
  if (opened.status !== 201) throw new Error(`proposal refused: ${JSON.stringify(opened.body)}`);
  return opened.body.data.id as string;
}

/** Change one published rule the way a Permissions edit does: save a draft over it, then publish. */
export async function setRule(tool: string, mode: string): Promise<void> {
  const { admin } = await tokens();
  const list = await nc(admin, "GET", `/v1/policies?tool=${encodeURIComponent(REF_PREFIX + tool)}&subject_type=role&state=published&limit=50`);
  const rule = (list.body.data as any[]).find((p) => p.targets?.tools?.includes(REF_PREFIX + tool));
  if (!rule) throw new Error(`no published rule for ${tool}`);
  const put = await nc(admin, "PUT", `/v1/policies/${rule.id}`, { kind: "tool_invocation", name: rule.name, subjects: rule.subjects, targets: rule.targets, config: { ...rule.config, mode } });
  if (put.status !== 200) throw new Error(`could not save the rule: ${JSON.stringify(put.body)}`);
  const pub = await nc(admin, "POST", `/v1/policies/${rule.id}/publish`);
  if (pub.status !== 200) throw new Error(`could not publish the rule: ${JSON.stringify(pub.body)}`);
}

/** Approve the open proposal as the local administrator, the way the panel's "Approve rules" does. */
export async function approveRules(proposalId: string): Promise<void> {
  const { admin } = await tokens();
  const current = await nc(admin, "GET", `/v1/approvals/${proposalId}`);
  const resolved = await nc(admin, "POST", `/v1/approvals/${proposalId}/resolve`, { resolution: "approved", expected_action_digest: current.body.data.action_digest });
  if (resolved.status !== 200) throw new Error(`could not approve the rules: ${JSON.stringify(resolved.body)}`);
}
