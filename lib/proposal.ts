import { createClient } from "@noblecloak/client";
import { z } from "zod";
import { TOOL_NAMES, type ToolName } from "../src/run/types";
import { ApprovalsError, isUnreachable, type Deps } from "./approvals";
import { assertMock, currentMode, upstreamBase, SIGN_IN_REQUIRED } from "./mode";

// The rule proposal an administrator approves. The setup skill's `propose.mjs` (or the plugin's `setup.mjs propose`)
// opens it; this reads it and approves it. Mock mode uses the local mock's `admin` token, which stays on this server.
// Deployment mode uses the signed-in person's bearer token from the request and never contacts the mock. With no
// proposal this is dormant.

export const PROPOSE_REF = "tool:noblecloak:propose-policy-set";

export type RuleMode = "always_allow" | "ask" | "deny";
/** `sideEffect`, `description` and `inputSchema` come from the proposal's tool entry; null when it has none. */
export type Rule = { tool: ToolName; mode: RuleMode; rationale: string; sideEffect: string | null; description: string | null; inputSchema: unknown };
export type Proposal = {
  id: string;
  actionDigest: string;
  state: "pending" | "approved" | "rejected" | "closed";
  agent: string | null;
  /** The service principal approving would bind to the agent, as proposed. */
  principal: string | null;
  rules: Rule[];
  /** How many policies the proposal carries. Approving applies all of them, shown or not. */
  policyCount: number;
  /** Anything in a pending proposal this page cannot state exactly, as raw values. Any entry blocks approval. */
  unrecognized: string[];
  /** Display name of who decided, from resolution_history. */
  decidedBy?: string;
};
export type ProposalRead = { reachable: boolean; proposal: Proposal | null };

const Raw = z.object({
  id: z.string(),
  state: z.string(),
  tool_ref: z.string(),
  action_digest: z.string(),
  created_at: z.string(),
  arguments: z.unknown().optional(),
  agent: z.object({ name: z.string().nullish() }).nullish(),
  resolution_history: z.array(z.object({ resolution: z.string(), by: z.object({ id: z.string(), display_name: z.string().optional() }) })).optional(),
});
type Raw = z.infer<typeof Raw>;

const baseUrlOf = (deps: Deps) => upstreamBase(deps);
const fetchOf = (deps: Deps) => deps.fetch ?? globalThis.fetch;

/**
 * Mock mode: a client with the mock's administrator token, or null where the deployment has no such route (then nothing
 * here applies). Deployment mode: a client with the caller's bearer, or a 401 when the request carried none.
 */
async function adminClient(deps: Deps) {
  if ((deps.mode ?? currentMode()) === "deployment") {
    if (!deps.bearer) throw new ApprovalsError(401, SIGN_IN_REQUIRED.message);
    const bearer = deps.bearer;
    return createClient({ baseUrl: baseUrlOf(deps), getToken: () => bearer, fetch: fetchOf(deps) });
  }
  assertMock("The administrator token", deps.mode);
  const res = await fetchOf(deps)(`${baseUrlOf(deps)}/__mock/tokens`);
  if (!res.ok) return null;
  const { admin } = (await res.json()) as { admin?: string };
  if (!admin) return null;
  return createClient({ baseUrl: baseUrlOf(deps), getToken: () => admin, fetch: fetchOf(deps) });
}

const TOOL_PREFIX = "ext:fernhill-desk:";
const toolOf = (ref: unknown): ToolName | null => {
  if (typeof ref !== "string" || !ref.startsWith(TOOL_PREFIX)) return null;
  const name = ref.slice(TOOL_PREFIX.length);
  return (TOOL_NAMES as readonly string[]).includes(name) ? (name as ToolName) : null;
};

const REF = (tool: ToolName) => `${TOOL_PREFIX}${tool}`;
const MODES: readonly string[] = ["always_allow", "ask", "deny"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const raw = (v: unknown) => JSON.stringify(v) ?? String(v);
const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));

/**
 * One policy as a rule this page can state exactly, or null. The panel says "this tool: this mode, for everyone", so
 * only a policy that means exactly that is a rule. The setup skill's baseline is this shape (`propose.mjs` buildProposal).
 */
function ruleOf(entry: unknown): Rule | null {
  if (!isRecord(entry) || !isRecord(entry.policy)) return null;
  const { kind, subjects, targets, config } = entry.policy;
  if (kind !== "tool_invocation") return null;
  if (!Array.isArray(subjects) || subjects.length !== 1) return null;
  const subject: unknown = subjects[0];
  if (!isRecord(subject) || subject.type !== "role" || subject.id !== "everyone") return null;
  if (!isRecord(targets) || !onlyKeys(targets, ["tools"]) || !Array.isArray(targets.tools) || targets.tools.length !== 1) return null;
  const tool = toolOf(targets.tools[0]);
  if (!tool) return null;
  if (!isRecord(config) || !onlyKeys(config, ["mode"]) || typeof config.mode !== "string" || !MODES.includes(config.mode)) return null;
  return { tool, mode: config.mode as RuleMode, rationale: typeof entry.rationale === "string" ? entry.rationale : "", sideEffect: null, description: null, inputSchema: null };
}

/** The contract's `side_effect_level` values (SIDE_EFFECT_LEVELS in `propose.mjs`). */
const SIDE_EFFECTS = ["read", "write", "delete", "external", "admin"];
/** The members `propose.mjs` accepts on a tool entry (TOOL_KEYS there). */
const TOOL_KEYS = ["tool_ref", "transport", "description", "input_schema", "side_effect_level", "owner_kind", "show_arguments_to_approvers"];

/**
 * Why a tool entry cannot be approved here, or null. Checks only what the skill itself fixes: `propose.mjs` always builds
 * transport external and owner org, and an approver must see the arguments. Which level a tool gets and its description
 * are the writer's own assessment, so neither is compared with the app; the panel shows both.
 */
function toolEntryProblem(t: unknown): string | null {
  if (!isRecord(t)) return "not a tool entry";
  if (!toolOf(t.tool_ref)) return "not one of this app's nine tools";
  if (!onlyKeys(t, TOOL_KEYS)) return "has a member the skill does not write";
  if (t.transport !== "external") return "transport is not external";
  if (t.owner_kind !== "org") return "owner is not the organisation";
  if (t.show_arguments_to_approvers !== true) return "hides its arguments from approvers";
  if (typeof t.side_effect_level !== "string" || !SIDE_EFFECTS.includes(t.side_effect_level)) return "has no valid side effect level";
  return null;
}

/** Everything approving would apply. Whatever cannot be stated exactly goes in `unrecognized`, never dropped. */
function readArguments(args: unknown): Pick<Proposal, "rules" | "policyCount" | "unrecognized" | "principal"> {
  if (!isRecord(args) || !Array.isArray(args.policies) || args.policies.length === 0) {
    return { rules: [], policyCount: 0, principal: null, unrecognized: [`The proposal's contents could not be read: ${raw(args)}`] };
  }
  const unrecognized: string[] = [];
  const rules: Rule[] = [];
  const assessed = new Map<ToolName, unknown>();
  for (const [key, value] of Object.entries(args)) {
    if (!["agent", "tools", "policies"].includes(key)) unrecognized.push(`${key}: ${raw(value)}`);
  }
  for (const entry of args.policies) {
    const rule = ruleOf(entry);
    if (!rule) unrecognized.push(raw(isRecord(entry) && "policy" in entry ? entry.policy : entry));
    else if (rules.some((r) => r.tool === rule.tool)) unrecognized.push(`A second rule on ${rule.tool}: ${raw((entry as { policy: unknown }).policy)}`);
    else {
      rules.push(rule);
      const { assessment } = entry as { assessment?: unknown };
      assessed.set(rule.tool, isRecord(assessment) ? assessment.side_effect_level : undefined);
    }
  }
  const tools: unknown[] = args.tools === undefined ? [] : Array.isArray(args.tools) ? args.tools : [args.tools];
  const seen = new Set<unknown>();
  for (const t of tools) {
    const ref = isRecord(t) ? t.tool_ref : undefined;
    const problem = toolEntryProblem(t) ?? (seen.has(ref) ? "is listed twice" : null);
    seen.add(ref);
    if (problem) {
      unrecognized.push(`Registers a tool that ${problem}: ${raw(t)}`);
      continue;
    }
    const rule = rules.find((r) => REF(r.tool) === ref);
    if (!rule) {
      unrecognized.push(`Registers a tool with no rule: ${raw(t)}`);
      continue;
    }
    const entry = t as { side_effect_level: string; description?: unknown; input_schema?: unknown };
    Object.assign(rule, { sideEffect: entry.side_effect_level, description: typeof entry.description === "string" ? entry.description : null, inputSchema: entry.input_schema ?? null });
    const level = assessed.get(rule.tool);
    if (level !== entry.side_effect_level) unrecognized.push(`${rule.tool}: the tool says side effect ${raw(entry.side_effect_level)}, its rule's assessment says ${raw(level)}`);
  }
  for (const rule of rules) {
    if (!seen.has(REF(rule.tool))) unrecognized.push(`A rule with no tool entry: ${rule.tool} (${rule.mode})`);
  }
  const principal = isRecord(args.agent) && typeof args.agent.principal_id === "string" ? args.agent.principal_id : null;
  return { rules, policyCount: args.policies.length, principal, unrecognized };
}

export const isApprovable = (p: Proposal): boolean => p.state === "pending" && p.unrecognized.length === 0 && p.policyCount > 0 && p.rules.length === p.policyCount;

export function toProposal(row: Raw): Proposal {
  const last = row.resolution_history?.at(-1);
  const state = row.state === "pending" ? "pending" : last?.resolution === "approved" ? "approved" : last?.resolution === "rejected" ? "rejected" : "closed";
  // A consumed approval no longer returns its arguments, and there is nothing left to approve, so only a pending one warns.
  const read = state === "pending" || row.arguments !== undefined ? readArguments(row.arguments) : { rules: [], policyCount: 0, principal: null, unrecognized: [] };
  return {
    id: row.id,
    actionDigest: row.action_digest,
    state,
    agent: row.agent?.name ?? null,
    ...read,
    ...(last ? { decidedBy: last.by.display_name ?? last.by.id } : {}),
  };
}

/** The open proposal, or else the most recent one, so the panel can show that the rules were approved. */
export async function readProposal(deps: Deps = {}): Promise<ProposalRead> {
  try {
    const client = await adminClient(deps);
    if (!client) return { reachable: true, proposal: null };
    const { data, response } = await client.GET("/v1/approvals", { params: { query: { limit: 50 } } });
    // Deployment mode: a refused token is not an empty list; say so, so the page can ask for a sign-in instead of showing nothing.
    // Mock mode keeps its answer for a refusal (an empty, reachable panel).
    if ((deps.mode ?? currentMode()) === "deployment" && (response.status === 401 || response.status === 403)) throw new ApprovalsError(response.status, `NobleCloak refused this sign-in (HTTP ${response.status}).`);
    const rows = (data?.data ?? []) as unknown as Raw[];
    const proposals = rows.filter((a) => a.tool_ref === PROPOSE_REF).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const chosen = proposals.find((a) => a.state === "pending") ?? proposals[0];
    if (!chosen) return { reachable: true, proposal: null };
    const detail = await client.GET("/v1/approvals/{id}", { params: { path: { id: chosen.id } } });
    const full = Raw.safeParse(detail.data?.data);
    // A detail that cannot be read falls back to the list row, which has no arguments: it shows, blocked, not gone.
    return { reachable: true, proposal: toProposal(full.success ? full.data : chosen) };
  } catch (e) {
    if (isUnreachable(e)) return { reachable: false, proposal: null };
    throw e;
  }
}

export type ApproveResult = { ok: true } | { ok: false; status: number; message: string };

export async function approveProposal(id: string, expectedActionDigest: string, deps: Deps = {}): Promise<ApproveResult> {
  const client = await adminClient(deps);
  if (!client) return { ok: false, status: 404, message: "This deployment has no local administrator." };
  // The disabled button is only a display. Nothing is resolved unless the deployment's answer now says this is a
  // pending proposal, the one on screen, that this page can state exactly.
  const detail = await client.GET("/v1/approvals/{id}", { params: { path: { id } } });
  if (detail.response.status === 404) return { ok: false, status: 404, message: "This proposal no longer exists." };
  const current = detail.response.status === 200 ? Raw.safeParse(detail.data?.data) : null;
  if (!current?.success || current.data.tool_ref !== PROPOSE_REF) return { ok: false, status: 502, message: "Could not read this proposal back from NobleCloak, so it was not approved." };
  const proposal = toProposal(current.data);
  if (current.data.action_digest !== expectedActionDigest || proposal.state !== "pending") return { ok: false, status: 409, message: "This proposal changed or was already decided. It was not approved." };
  if (!isApprovable(proposal)) return { ok: false, status: 422, message: "This proposal contains something this page cannot show, so it cannot be approved here." };
  const { data, error, response } = await client.POST("/v1/approvals/{id}/resolve", {
    params: { path: { id } },
    body: { resolution: "approved", expected_action_digest: expectedActionDigest },
  });
  if (data) return { ok: true };
  const problem = error as { detail?: string; title?: string; code?: string } | undefined;
  return { ok: false, status: response.status, message: problem?.detail ?? problem?.title ?? `The request was refused (HTTP ${response.status}).` };
}
