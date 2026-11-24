import { createClient } from "@noblecloak/client";
import { APPROVER_TEAM, PERSONA_TEAM, TEAM_LABEL, type Team } from "./approver-routing";
import { assertMock, currentMode, upstreamBase, SIGN_IN_REQUIRED, type Mode } from "./mode";
import { TOOL_NAMES, type Run, type ToolName } from "../src/run/types";

// Approvals for the Fernhill Desk right-hand panel, read from NobleCloak (the local mock in this repo, or in deployment
// mode a real deployment).
// Mock mode: the server-side functions fetch the persona approver tokens from the mock; nothing token-shaped is ever
// returned to a page. Deployment mode: they use the bearer token of the signed-in person that the request carried
// (`deps.bearer`), the persona is ignored, and the mock is never contacted.
// The helpers at the bottom run in the browser and talk only to this app's own /api routes.

export type PersonaKey = "priya" | "sam";
export const PERSONAS: Record<PersonaKey, { displayName: string; team: string }> = {
  priya: { displayName: "Priya Shah", team: TEAM_LABEL[PERSONA_TEAM.priya] },
  sam: { displayName: "Sam Okoye", team: TEAM_LABEL[PERSONA_TEAM.sam] },
};
/** The demo approver on a team, for "switch to ..." hints. */
export const personaOnTeam = (team: Team): PersonaKey => (Object.keys(PERSONA_TEAM) as PersonaKey[]).find((p) => PERSONA_TEAM[p] === team) ?? DEFAULT_PERSONA;
export const DEFAULT_PERSONA: PersonaKey = "priya";
export const PERSONA_COOKIE = "fernhill_persona";

export const parsePersona = (value: string | null | undefined): PersonaKey => (value === "sam" ? "sam" : DEFAULT_PERSONA);

// Which team a pending call waits on is APPROVER_TEAM (lib/approver-routing.ts). The same table names the approvers
// on the two rules in the local mock, and NobleCloak enforces it: see `canDecide` below. A tool without a team still
// shows, because a rule change can make any of the nine ask.
const TOOL_PREFIX = "ext:fernhill-desk:";

export type Decision = { resolution: "approved" | "rejected"; by: string; reason?: string; at: string };
export type ApprovalView = {
  id: string;
  tool: ToolName;
  args: unknown;
  waitingOn: Team | null;
  /**
   * False when NobleCloak says this reader may not decide the approval (it withholds the arguments from such a reader:
   * `arguments_state: withheld`). The panel then offers no buttons. NobleCloak refuses the decision either way.
   */
  canDecide: boolean;
  actionDigest: string;
  /** NobleCloak's own state: pending, approved, rejected, consumed, expired... collapsed to what the panel needs. */
  state: "pending" | "approved" | "rejected" | "closed";
  /** Read from the approval's resolution_history, never from a tool message. */
  decision?: Decision;
};

export type Deps = { baseUrl?: string; fetch?: typeof globalThis.fetch; mode?: Mode; /** Deployment mode: the signed-in person's token, from the request. */ bearer?: string };
export type ResolveResult = { ok: true; approval: ApprovalView | null } | { ok: false; status: number; message: string };

/** The mock answered, but not with what the panel needs (not a "not running" case). */
export class ApprovalsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const baseUrlOf = (deps: Deps) => upstreamBase(deps);
const fetchOf = (deps: Deps) => deps.fetch ?? globalThis.fetch;

/**
 * undici's fetch rejects with `TypeError: fetch failed` when it cannot connect. That is "not running", not a fault.
 * Any other TypeError (a bug in this code, a bad URL) is not, so it is thrown rather than hidden.
 */
export const isUnreachable = (e: unknown) => e instanceof TypeError && e.message === "fetch failed";

/** An approval stamped later than this many ms ahead of the app's clock came from a mock whose clock was advanced. */
const CLOCK_SKEW_MS = 2000;

async function personaToken(persona: PersonaKey, deps: Deps): Promise<string> {
  assertMock("The persona approver token", deps.mode);
  const res = await fetchOf(deps)(`${baseUrlOf(deps)}/__demo/token?as=${persona}`);
  if (!res.ok) throw new ApprovalsError(res.status, `The local mock would not issue a token for ${persona} (HTTP ${res.status}).`);
  return ((await res.json()) as { token: string }).token;
}

async function api(persona: PersonaKey, deps: Deps) {
  if ((deps.mode ?? currentMode()) === "deployment") {
    // The one signed-in person decides. No persona, and no token of this server's own.
    if (!deps.bearer) throw new ApprovalsError(401, SIGN_IN_REQUIRED.message);
    const bearer = deps.bearer;
    return createClient({ baseUrl: baseUrlOf(deps), getToken: () => bearer, fetch: fetchOf(deps) });
  }
  const token = await personaToken(persona, deps);
  return createClient({ baseUrl: baseUrlOf(deps), getToken: () => token, fetch: fetchOf(deps) });
}

type Raw = {
  id: string;
  state: string;
  tool_ref: string;
  action_digest: string;
  created_at: string;
  arguments?: unknown;
  arguments_state?: string;
  resolution_history?: { resolution: string; by: { display_name?: string; id: string }; at: string; reason?: string }[];
};

const toolOf = (ref: string): ToolName | null => {
  if (!ref.startsWith(TOOL_PREFIX)) return null;
  const name = ref.slice(TOOL_PREFIX.length);
  return (TOOL_NAMES as readonly string[]).includes(name) ? (name as ToolName) : null;
};

/** One approval as the panel sees it, or null when it is not for one of Fernhill Desk's nine tools. */
export function toView(raw: Raw): ApprovalView | null {
  const tool = toolOf(raw.tool_ref);
  if (!tool) return null;
  const last = raw.resolution_history?.at(-1);
  const state = raw.state === "pending" ? "pending" : raw.state === "approved" || raw.state === "rejected" ? raw.state : last ? (last.resolution === "approved" ? "approved" : "rejected") : "closed";
  return {
    id: raw.id,
    tool,
    args: raw.arguments,
    waitingOn: APPROVER_TEAM[tool] ?? null,
    canDecide: raw.arguments_state !== "withheld",
    actionDigest: raw.action_digest,
    state,
    ...(last && (last.resolution === "approved" || last.resolution === "rejected")
      ? { decision: { resolution: last.resolution, by: last.by.display_name ?? last.by.id, ...(last.reason ? { reason: last.reason } : {}), at: last.at } }
      : {}),
  };
}

const order = (v: ApprovalView) => TOOL_NAMES.indexOf(v.tool);

/**
 * The approvals of the current run. Once a step names an approval (`reconcile` records it) only named approvals
 * count, so the match is exact. Before that, for example in the moment before the agent's result is read: NobleCloak's
 * approval carries its own external run id and scope, not this app's run id, and does not return the adapter's thread
 * id, so an approval belongs to the run when it was opened at or after the run started. Dormant: an idle run, a mock that is not running, or a run
 * with no approvals all give [] and write nothing to the console.
 */
export async function listRunApprovals(run: Pick<Run, "id" | "startedAt" | "steps">, persona: PersonaKey, deps: Deps = {}): Promise<ApprovalView[]> {
  return (await fetchRunApprovals(run, persona, deps)).approvals;
}

/** Like `listRunApprovals`, but says whether the mock could be reached, so "down" is not shown as "nothing waiting". */
export async function fetchRunApprovals(
  run: Pick<Run, "id" | "startedAt" | "steps">,
  persona: PersonaKey,
  deps: Deps = {},
): Promise<{ reachable: boolean; approvals: ApprovalView[] }> {
  if (!run.startedAt) {
    // Idle needs no list, but in deployment mode "nothing waiting" is only an answer for a token the deployment accepts.
    if ((deps.mode ?? currentMode()) === "deployment") await verifyBearer(deps);
    return { reachable: true, approvals: [] };
  }
  const now = Date.now();
  const since = Date.parse(run.startedAt);
  const known = new Set(run.steps.flatMap((s) => (s.approvalId ? [s.approvalId] : [])));
  try {
    const client = await api(persona, deps);
    const { data, error, response } = await client.GET("/v1/approvals", { params: { query: { limit: 50 } } });
    if (error || !data) throw new ApprovalsError(response.status, `Could not list approvals (HTTP ${response.status}).`);
    const belongs = (a: Raw) => (known.size > 0 ? known.has(a.id) : Date.parse(a.created_at) >= since && Date.parse(a.created_at) <= now + CLOCK_SKEW_MS);
    const mine = (data.data as unknown as Raw[]).filter(belongs).filter((a) => toView(a) !== null);
    // The list leaves out the arguments; the single-approval read has them.
    const full = await Promise.all(mine.map(async (a) => (await readOne(client, a.id)) ?? a));
    return { reachable: true, approvals: full.flatMap((a) => toView(a) ?? []).sort((a, b) => order(a) - order(b)) };
  } catch (e) {
    if (isUnreachable(e)) return { reachable: false, approvals: [] };
    throw e;
  }
}

/**
 * Deployment mode: asks the deployment, with this request's own token, whether it accepts it (one cheap list read).
 * Throws ApprovalsError with the deployment's 401/403, or 502 when it cannot be reached or answers otherwise.
 * The token is never decoded here: a header being present proves nothing, the deployment's answer does.
 */
export async function verifyBearer(deps: Deps): Promise<void> {
  try {
    const client = await api(DEFAULT_PERSONA, deps);
    const { response } = await client.GET("/v1/approvals", { params: { query: { limit: 1 } } });
    if (response.status === 401 || response.status === 403) throw new ApprovalsError(response.status, `NobleCloak refused this sign-in (HTTP ${response.status}).`);
    if (!response.ok) throw new ApprovalsError(502, `Could not check this sign-in (HTTP ${response.status}).`);
  } catch (e) {
    if (isUnreachable(e)) throw new ApprovalsError(502, "NobleCloak could not be reached to check this sign-in.");
    throw e;
  }
}

async function readOne(client: Awaited<ReturnType<typeof api>>, id: string): Promise<Raw | null> {
  const { data, response } = await client.GET("/v1/approvals/{id}", { params: { path: { id } } });
  if (response.status === 404) return null;
  if (!data) throw new ApprovalsError(response.status, `Could not read approval ${id} (HTTP ${response.status}).`);
  return data.data as unknown as Raw;
}

export async function getApproval(id: string, persona: PersonaKey, deps: Deps = {}): Promise<ApprovalView | null> {
  const raw = await readOne(await api(persona, deps), id);
  return raw ? toView(raw) : null;
}

/** Record a decision as `persona`. A refusal is a result, not a throw, so the panel can show it inline. */
export async function resolveApproval(
  id: string,
  decision: "approve" | "deny",
  expectedActionDigest: string,
  persona: PersonaKey,
  reason?: string,
  deps: Deps = {},
): Promise<ResolveResult> {
  const client = await api(persona, deps);
  const { data, error, response } = await client.POST("/v1/approvals/{id}/resolve", {
    params: { path: { id } },
    body: { resolution: decision === "approve" ? "approved" : "rejected", expected_action_digest: expectedActionDigest, ...(reason ? { reason } : {}) },
  });
  if (data) return { ok: true, approval: toView(data.data as unknown as Raw) };
  const detail = (error as { detail?: string; title?: string } | undefined)?.detail ?? (error as { title?: string } | undefined)?.title;
  return { ok: false, status: response.status, message: detail ?? `The request was refused (HTTP ${response.status}).` };
}

// ---- Browser side ----

export const CONFLICT_MESSAGE = "This request changed or was already decided. The list has been refreshed.";

/**
 * Send a decision through this app's own route. Returns the message to show inline, or null on success. The digest
 * is the one on screen, so a request that changed since the page last loaded is refused (409) rather than approved.
 */
export async function submitDecision(
  approval: ApprovalView,
  decision: "approve" | "deny",
  reason: string | undefined,
  refetch: () => Promise<void>,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    const res = await doFetch(`/api/approvals/${approval.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, expectedActionDigest: approval.actionDigest, ...(reason ? { reason } : {}) }),
    });
    if (res.ok) {
      await refetch();
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.status === 409) {
      await refetch();
      return CONFLICT_MESSAGE;
    }
    return body.message ?? "Could not record the decision.";
  } catch {
    return "Could not record the decision. Try again.";
  }
}
