"use client";

import { Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentMode, type Mode } from "../lib/mode";
import { summarize } from "../lib/steps";
import type { Run } from "../src/run/types";
import { AppShell } from "./AppShell";
import { ApprovalPanel } from "./ApprovalPanel";
import { ProposalPanel } from "./ProposalPanel";
import { RunSteps } from "./RunSteps";
import { RunSummary } from "./RunSummary";
import { SignInBar } from "./SignInBar";
import { TicketCard } from "./TicketCard";
import { useApiFetch } from "./useApiFetch";

const POLL_MS = 500;
// Idle and finished pages still poll, slowly, so a reset or a run started elsewhere (another tab, a script) shows up.
const IDLE_POLL_MS = 1000;

/** What the run page says when a call to /api/run does not succeed. */
export type RunNote = { kind: "sign_in" } | { kind: "retry"; text: string };

/**
 * Deployment mode answers 401 when there is no sign-in or the deployment rejected the token: the fix is to sign in,
 * not to retry. Mock mode never answers 401, and any other failure keeps its retry text.
 */
export function noteFor(status: number | null, text: string, mode: Mode = currentMode()): RunNote {
  return status === 401 && mode === "deployment" ? { kind: "sign_in" } : { kind: "retry", text };
}

/** The same sign-in control the page header carries, with a line saying why it is shown. */
export function RunNoteView({ note }: { note: RunNote }) {
  if (note.kind === "retry") {
    return (
      <p className="note" role="alert">
        {note.text}
      </p>
    );
  }
  return (
    <div className="note" role="alert" data-testid="run-sign-in">
      <p>Sign in to NobleCloak to see and start this run.</p>
      <SignInBar />
    </div>
  );
}

class HttpStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

type Ticket = { from: string; time: string; text: string };

export function OnboardingRun({ initialRun, subtitle, ticket }: { initialRun: Run; subtitle: string; ticket: Ticket }) {
  const [run, setRun] = useState<Run>(initialRun);
  // Deployment mode attaches the signed-in person's token, which /api/run requires.
  const apiFetch = useApiFetch();
  const [note, setNote] = useState<RunNote | null>(null);
  const [busy, setBusy] = useState(false);
  // Whole seconds from start to the moment this page saw the run finish. Null when it was already finished on load.
  const [seconds, setSeconds] = useState<{ runId: string; value: number } | null>(null);
  // Bumped on start and reset so a poll already in flight cannot overwrite the newer state.
  const epoch = useRef(0);
  const active = run.state === "running" || run.state === "parked";

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      const mine = epoch.current;
      const wasActive = active;
      try {
        const res = await apiFetch("/api/run", { cache: "no-store" });
        if (!res.ok) throw new HttpStatus(res.status);
        const next = (await res.json()) as Run;
        if (stopped || mine !== epoch.current) return;
        setRun(next);
        setNote(null);
        if (wasActive && next.state === "finished") {
          setSeconds((cur) =>
            cur?.runId === next.id ? cur : { runId: next.id, value: Math.max(0, Math.round((Date.now() - Date.parse(next.startedAt)) / 1000)) },
          );
        }
      } catch (error) {
        if (!stopped) setNote(noteFor(error instanceof HttpStatus ? error.status : null, "Having trouble reaching the run. Retrying."));
      } finally {
        inFlight = false;
      }
    };
    const id = setInterval(tick, active ? POLL_MS : IDLE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [active, apiFetch]);

  const start = useCallback(async () => {
    setBusy(true);
    epoch.current += 1;
    try {
      const res = await apiFetch("/api/run", { method: "POST" });
      if (res.ok || res.status === 409) {
        // On 409 a run is already active; show it rather than an error.
        let body: Run;
        if (res.ok) {
          body = (await res.json()) as Run;
        } else {
          const current = await apiFetch("/api/run", { cache: "no-store" });
          if (!current.ok) throw new HttpStatus(current.status);
          body = (await current.json()) as Run;
        }
        setRun(body);
        setNote(null);
      } else {
        setNote(noteFor(res.status, "Could not start the run."));
      }
    } catch (error) {
      setNote(noteFor(error instanceof HttpStatus ? error.status : null, "Could not start the run."));
    } finally {
      setBusy(false);
    }
  }, [apiFetch]);

  const reset = useCallback(async () => {
    epoch.current += 1;
    try {
      const res = await apiFetch("/api/run", { method: "DELETE" });
      if (!res.ok) throw new HttpStatus(res.status);
      setRun((await res.json()) as Run);
      setSeconds(null);
      setNote(null);
    } catch (error) {
      setNote(noteFor(error instanceof HttpStatus ? error.status : null, "Could not reset the run."));
    }
  }, [apiFetch]);

  const summary = summarize(run, seconds?.runId === run.id ? seconds.value : null);

  // Dormant until governance is present: with no approvals for this run the panel renders nothing.
  const approvalPanel = <ApprovalPanel run={run} />;

  return (
    <AppShell
      active="onboarding"
      side={
        <>
          <ProposalPanel />
          <div className="lbl">Request</div>
          <TicketCard {...ticket} />
          {summary && (
            <>
              <div className="lbl">Run</div>
              <RunSummary summary={summary} />
            </>
          )}
          {approvalPanel}
          {note && <RunNoteView note={note} />}
        </>
      }
    >
      <div className="crumb">Onboarding / Maya Torres</div>
      <div className="who">
        <div className="pic" aria-hidden="true">
          MT
        </div>
        <div>
          <h1>Welcome, Maya</h1>
          <p>{subtitle}</p>
        </div>
        <div className="sp actions">
          <button type="button" className="btn go" onClick={start} disabled={run.state !== "idle" || busy}>
            <Play aria-hidden="true" />
            Run
          </button>
        </div>
      </div>
      <RunSteps run={run} />
      <button type="button" className="reset" aria-label="Reset run" onClick={reset}>
        <RotateCcw aria-hidden="true" />
      </button>
    </AppShell>
  );
}
