"use client";

import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isApprovable, type Proposal, type ProposalRead, type Rule, type RuleMode } from "../lib/proposal";
import { STEP_META, toolId } from "../lib/steps";
import { useApiFetch } from "./useApiFetch";

const GROUPS: { mode: RuleMode; label: string }[] = [
  { mode: "always_allow", label: "Runs freely" },
  { mode: "ask", label: "Asks a person" },
  { mode: "deny", label: "Never allowed" },
];

export type ProposalViewProps = {
  proposal: Proposal | null;
  busy: boolean;
  message: string | null;
  onApprove: (proposal: Proposal) => void;
};

function RuleRow({ rule }: { rule: Rule }) {
  return (
    <li title={rule.rationale} data-tool={rule.tool}>
      <span>{STEP_META[rule.tool].label}</span>
      <code>
        {toolId(rule.tool)}
        {rule.sideEffect ? ` · ${rule.sideEffect}` : ""}
      </code>
      <details>
        <summary>Details</summary>
        {rule.description && <p>{rule.description}</p>}
        <pre>{JSON.stringify(rule.inputSchema, null, 2)}</pre>
      </details>
    </li>
  );
}

/** Renders nothing when there is no proposal, which is what keeps an ungoverned app dormant. */
export function ProposalPanelView({ proposal, busy, message, onApprove }: ProposalViewProps) {
  if (!proposal) return null;
  if (proposal.state !== "pending") {
    const approved = proposal.state === "approved";
    return (
      <section aria-label="Rules" data-testid="proposal-panel" data-state={proposal.state}>
        <div className={`appr decided ${proposal.state}`}>
          <h4>{approved ? "Rules in force" : "Rules not approved"}</h4>
          <p>
            {approved ? "Approved" : "Closed"}
            {proposal.decidedBy ? ` by ${proposal.decidedBy}` : ""}
          </p>
        </div>
      </section>
    );
  }
  const countOff = proposal.rules.length + proposal.unrecognized.length < proposal.policyCount || (proposal.unrecognized.length === 0 && proposal.rules.length !== proposal.policyCount);
  return (
    <section aria-label="Rules" data-testid="proposal-panel" data-state="pending">
      <div className="lbl">Rules to approve</div>
      <div className="appr rules">
        <h4>
          <ShieldCheck aria-hidden="true" />
          {proposal.agent ?? "This agent"} asks to run under these rules
        </h4>
        {GROUPS.map(({ mode, label }) => {
          const rules = proposal.rules.filter((r) => r.mode === mode);
          return rules.length === 0 ? null : (
            <div className="rulegroup" key={mode} data-mode={mode}>
              <b className={mode}>
                {label} ({rules.length})
              </b>
              <ul>
                {rules.map((r) => (
                  <RuleRow key={r.tool} rule={r} />
                ))}
              </ul>
            </div>
          );
        })}
        {(proposal.unrecognized.length > 0 || countOff) && (
          <div className="unrecognized" role="alert" data-testid="proposal-unrecognized">
            <b>
              <AlertTriangle aria-hidden="true" />
              Do not approve here: this proposal has something this page cannot show exactly
            </b>
            {countOff && (
              <p>
                Showing {proposal.rules.length} of {proposal.policyCount} rules.
              </p>
            )}
            {proposal.unrecognized.map((value, i) => (
              <code key={i}>{value}</code>
            ))}
          </div>
        )}
        {proposal.principal && <p className="asadmin">Runs as {proposal.principal}</p>}
        <div className="acts">
          <button type="button" className="btn go" disabled={busy || !isApprovable(proposal)} onClick={() => onApprove(proposal)}>
            <Check aria-hidden="true" />
            Approve rules
          </button>
        </div>
        <p className="asadmin">Nothing is registered or published until you approve. You are approving as the administrator.</p>
        {message && (
          <p className="note" role="alert" data-testid="proposal-message">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}

const POLL_MS = 1500;

/** Polls this app's /api/proposal. Silent while NobleCloak is not running or has nothing to show. */
export function ProposalPanel() {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const apiFetch = useApiFetch();

  const refetch = useCallback(async () => {
    try {
      const res = await apiFetch("/api/proposal", { cache: "no-store" });
      if (!res.ok) return; // a hiccup: keep what is on screen; the next poll tries again
      const next = (await res.json()) as ProposalRead;
      setProposal(next.reachable ? next.proposal : null);
    } catch {
      /* this app itself is unreachable; the run poll already says so */
    }
  }, [apiFetch]);

  useEffect(() => {
    void refetch();
    const id = setInterval(refetch, POLL_MS);
    return () => clearInterval(id);
  }, [refetch]);

  const onApprove = useCallback(
    async (p: Proposal) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await apiFetch(`/api/proposal/${p.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedActionDigest: p.actionDigest }) });
        if (!res.ok) setMessage(((await res.json().catch(() => ({}))) as { message?: string }).message ?? "Could not approve the rules.");
        await refetch();
      } catch {
        setMessage("Could not approve the rules. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [refetch, apiFetch],
  );

  return <ProposalPanelView proposal={proposal} busy={busy} message={message} onApprove={onApprove} />;
}
