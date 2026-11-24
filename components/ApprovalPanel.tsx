"use client";

import { Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PERSONAS, personaOnTeam, submitDecision, type ApprovalView, type PersonaKey } from "../lib/approvals";
import { TEAM_LABEL } from "../lib/approver-routing";
import { STEP_META } from "../lib/steps";
import type { Run } from "../src/run/types";
import { PersonaSwitch } from "./PersonaSwitch";
import { useApiFetch } from "./useApiFetch";
import { currentMode } from "../lib/mode";

export const DEFAULT_DENY_REASON = "Not approved";

const usd = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-US")} / month` : undefined);

type Field = { label: string; value: (a: Record<string, unknown>) => string | undefined; big?: boolean };
const str = (key: string) => (a: Record<string, unknown>) => (typeof a[key] === "string" ? (a[key] as string) : undefined);

/** What each call shows, taken only from the arguments the deployment returned. A missing argument shows no row. */
const CARDS: Record<string, { title: string; fields: Field[] }> = {
  mercury_issue_card: {
    title: "Issue company card",
    fields: [
      { label: "Cardholder", value: str("cardholder") },
      { label: "Limit", value: (a) => usd(a.limit_monthly), big: true },
      { label: "Copied from", value: str("copied_from") },
      { label: "Account", value: str("account") },
    ],
  },
  adp_create_employee: {
    title: "Create payroll record",
    fields: [
      { label: "Employee", value: str("employee") },
      { label: "Title", value: str("title") },
      { label: "Salary", value: str("salary_source") },
    ],
  },
};

/**
 * What a card says when NobleCloak will not let this reader decide the request. With the persona switch on screen it
 * names who to switch to; in deployment mode there is one signed-in person and nobody to switch to.
 */
export function notYoursMessage(approval: ApprovalView, hidePersona: boolean): string {
  if (!approval.waitingOn) return "You are not an approver for this request.";
  const team = TEAM_LABEL[approval.waitingOn];
  if (hidePersona) return `Only ${team} can decide this.`;
  return `Only ${team} can decide this. Switch to ${PERSONAS[personaOnTeam(approval.waitingOn)].displayName.split(" ")[0]}.`;
}

export const UNREACHABLE_MESSAGE = "NobleCloak unreachable. Retrying.";
export const WORKER_MESSAGE = "Waiting for the worker. If it's stuck, restart it with bun run reset";
/** A resume normally takes well under a second, so a decision older than this has not been picked up. */
export const WORKER_GRACE_MS = 3000;

/** Decided calls whose step is still waiting after the grace period: the resumer is not running, or is stuck. */
export function waitingForWorker(approvals: ApprovalView[], steps: Run["steps"], now: number): string[] {
  return approvals
    .filter((a) => a.decision && now - Date.parse(a.decision.at) > WORKER_GRACE_MS && steps.find((s) => s.tool === a.tool)?.status === "waiting")
    .map((a) => a.id);
}

export type PanelState = { persona: PersonaKey; approvals: ApprovalView[]; unreachable: boolean };
/** `persona` is absent in deployment mode, which has none. */
export type ListResponse = { persona?: PersonaKey; approvals: ApprovalView[]; reachable: boolean };

/**
 * Fold one /api/approvals answer into the panel. If NobleCloak cannot be reached, the cards already on screen stay
 * (a decision may be in flight) and are flagged; a panel that never had approvals stays silent, so an ungoverned
 * run shows nothing.
 */
export function nextPanelState(prev: PanelState, res: ListResponse): PanelState {
  if (!res.reachable) return prev.approvals.length > 0 ? { ...prev, unreachable: true } : prev;
  return { persona: res.persona ?? prev.persona, approvals: res.approvals, unreachable: false };
}

/** Poll while a run is going or something still waits on a person. A finished run with nothing pending is settled. */
export function shouldPoll(runState: Run["state"], approvals: ApprovalView[]): boolean {
  if (runState === "idle") return false;
  if (runState === "finished") return approvals.some((a) => a.state === "pending");
  return true;
}

export type PanelViewProps = {
  approvals: ApprovalView[];
  persona: PersonaKey;
  message: string | null;
  unreachable: boolean;
  busyId: string | null;
  stalled?: string[];
  reasons: Record<string, string>;
  onReason: (id: string, value: string) => void;
  onDecide: (approval: ApprovalView, decision: "approve" | "deny") => void;
  onSwitch: (next: PersonaKey) => void;
  /** Deployment mode: the one signed-in person decides, so there is no persona to switch. */
  hidePersona?: boolean;
};

/** The panel's markup. Renders nothing when there are no approvals, which is what keeps an ungoverned run dormant. */
export function ApprovalPanelView({ approvals, persona, message, unreachable, busyId, stalled = [], reasons, onReason, onDecide, onSwitch, hidePersona = false }: PanelViewProps) {
  if (approvals.length === 0) return null;
  const locked = busyId !== null || unreachable;
  const shownMessage = message ?? (unreachable ? UNREACHABLE_MESSAGE : null);
  const pending = approvals.filter((a) => a.state === "pending");
  const decided = approvals.filter((a) => a.state !== "pending");
  return (
    <section data-testid="approval-panel" aria-label="Approvals">
      {!hidePersona && <PersonaSwitch persona={persona} onSwitch={onSwitch} disabled={locked} />}
      {pending.length > 0 && <div className="lbl">Needs approval</div>}
      {pending.map((a) => {
        const spec = CARDS[a.tool];
        const args = (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, unknown>;
        return (
          <div className="appr" key={a.id} data-approval={a.id} data-tool={a.tool}>
            <h4>{spec?.title ?? STEP_META[a.tool].label}</h4>
            <div className="chipline">{a.waitingOn ? `Waiting for ${TEAM_LABEL[a.waitingOn]}` : "Waiting for approval"}</div>
            {!a.canDecide ? (
              <p className="notyours" data-testid="not-yours">
                {notYoursMessage(a, hidePersona)}
              </p>
            ) : (
              <>
                <div className="kv">
                  {spec
                    ? spec.fields.map((f) => {
                        const v = f.value(args);
                        return v === undefined ? null : <FieldRow key={f.label} label={f.label} value={v} big={f.big} />;
                      })
                    : Object.entries(args).map(([k, v]) => <FieldRow key={k} label={k.replace(/_/g, " ")} value={String(v)} />)}
                </div>
                <label className="reason">
                  <span>Reason if denying</span>
                  <input type="text" value={reasons[a.id] ?? DEFAULT_DENY_REASON} maxLength={200} onChange={(e) => onReason(a.id, e.target.value)} />
                </label>
                <div className="acts">
                  <button type="button" className="btn go" disabled={locked} onClick={() => onDecide(a, "approve")}>
                    <Check aria-hidden="true" />
                    Approve
                  </button>
                  <button type="button" className="btn alt" disabled={locked} onClick={() => onDecide(a, "deny")}>
                    <X aria-hidden="true" />
                    Deny
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {decided.length > 0 && <div className="lbl">Decided</div>}
      {decided.map((a) => (
        <div className={`appr decided ${a.state}`} key={a.id} data-approval={a.id} data-tool={a.tool}>
          <h4>{CARDS[a.tool]?.title ?? STEP_META[a.tool].label}</h4>
          <p>
            {a.decision ? `${a.decision.resolution === "approved" ? "Approved" : "Denied"} by ${a.decision.by}` : "Closed"}
            {a.decision?.reason ? `: ${a.decision.reason}` : ""}
          </p>
          {stalled.includes(a.id) && (
            <p className="stalled" role="status" data-testid="worker-waiting">
              {WORKER_MESSAGE}
            </p>
          )}
        </div>
      ))}
      {shownMessage && (
        <p className="note" role="alert" data-testid="approval-message">
          {shownMessage}
        </p>
      )}
    </section>
  );
}

function FieldRow({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <>
      <span>{label}</span>
      <b className={big ? "big" : undefined}>{value}</b>
    </>
  );
}

const POLL_MS = 700;

/** Container: polls this app's /api/approvals while a run is going and hands the result to the view. */
export function ApprovalPanel({ run }: { run: Run }) {
  const [panel, setPanel] = useState<PanelState>({ persona: "priya", approvals: [], unreachable: false });
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const apiFetch = useApiFetch();
  const runId = useRef(run.id);
  runId.current = run.id;
  const idle = run.state === "idle";
  const polling = shouldPoll(run.state, panel.approvals);

  const refetch = useCallback(async () => {
    const mine = runId.current;
    try {
      const res = await apiFetch("/api/approvals", { cache: "no-store" });
      if (!res.ok) return; // a hiccup: keep what is on screen; the next poll tries again
      const next = (await res.json()) as ListResponse;
      if (runId.current === mine) setPanel((cur) => nextPanelState(cur, next));
    } catch {
      /* this app itself is unreachable; the run poll already says so */
    }
  }, [apiFetch]);

  useEffect(() => {
    if (idle) {
      setPanel((cur) => (cur.approvals.length || cur.unreachable ? { ...cur, approvals: [], unreachable: false } : cur));
      setMessage(null);
      return;
    }
    void refetch(); // once on every change of run or state, so a run that just finished is read one last time
    if (!polling) return;
    const id = setInterval(refetch, POLL_MS);
    return () => clearInterval(id);
  }, [idle, run.id, run.state, polling, refetch]);

  const onDecide = useCallback(
    async (approval: ApprovalView, decision: "approve" | "deny") => {
      setBusyId(approval.id);
      setMessage(null);
      const reason = decision === "deny" ? (reasons[approval.id]?.trim() || DEFAULT_DENY_REASON) : undefined;
      const out = await submitDecision(approval, decision, reason, refetch, apiFetch);
      setMessage(out);
      setBusyId(null);
    },
    [reasons, refetch, apiFetch],
  );

  const onSwitch = useCallback(
    async (next: PersonaKey) => {
      setMessage(null);
      try {
        const res = await fetch("/api/persona", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: next }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setPanel((cur) => ({ ...cur, persona: next }));
        await refetch();
      } catch {
        setMessage(`Could not switch to ${PERSONAS[next].displayName}.`);
      }
    },
    [refetch],
  );

  return (
    <ApprovalPanelView
      approvals={panel.approvals}
      persona={panel.persona}
      message={message}
      unreachable={panel.unreachable}
      busyId={busyId}
      stalled={waitingForWorker(panel.approvals, run.steps, Date.now())}
      reasons={reasons}
      onReason={(id, value) => setReasons((cur) => ({ ...cur, [id]: value }))}
      onDecide={onDecide}
      onSwitch={onSwitch}
      hidePersona={currentMode() === "deployment"}
    />
  );
}
