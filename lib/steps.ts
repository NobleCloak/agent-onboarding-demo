import type { Run, Step, ToolName } from "../src/run/types";
import type { Vendor } from "./seed";

export type StepGroup = "Accounts" | "On the way to her desk" | "Money and access";
export const GROUPS: StepGroup[] = ["Accounts", "On the way to her desk", "Money and access"];

export const STEP_META: Record<ToolName, { label: string; group: StepGroup; vendor: Vendor }> = {
  okta_create_user: { label: "Okta account", group: "Accounts", vendor: "okta" },
  google_create_account: { label: "Google Workspace", group: "Accounts", vendor: "google" },
  slack_invite: { label: "Slack and team channels", group: "Accounts", vendor: "slack" },
  cdw_order_laptop: { label: "Laptop 14", group: "On the way to her desk", vendor: "cdw" },
  merch_order_polos: { label: "Two polos, size M", group: "On the way to her desk", vendor: "merch" },
  print_order_business_cards: { label: "Business cards", group: "On the way to her desk", vendor: "print" },
  adp_create_employee: { label: "Payroll record", group: "Money and access", vendor: "adp" },
  mercury_issue_card: { label: "Company card", group: "Money and access", vendor: "mercury" },
  okta_assign_admin_role: { label: "Okta role", group: "Money and access", vendor: "okta" },
};

/** "okta_create_user" -> "okta.create_user" (first underscore only, as in the mockup). */
export const toolId = (tool: ToolName) => tool.replace("_", ".");

const WAITING_ON: Partial<Record<ToolName, string>> = {
  adp_create_employee: "Waiting for HR",
  mercury_issue_card: "Waiting for Finance",
};
const SKIPPED: Partial<Record<ToolName, string>> = {
  mercury_issue_card: "Not issued",
  adp_create_employee: "Not created",
};

export type StepView = {
  /** CSS class suffix: done | wait | deny | muted. */
  tone: "done" | "wait" | "deny" | "muted";
  icon: "check" | "clock" | "ban" | "alert" | "circle" | "minus";
  text: string;
  /** Explanation for denied and failed steps; shown to assistive tech and on hover. */
  reason?: string;
  /** A person's reason, shown on the row itself. */
  note?: string;
};

/** What a row says about one step. Always derived from the step's own status. */
export function stepView(step: Step): StepView {
  switch (step.status) {
    case "done":
      return { tone: "done", icon: "check", text: "Done" };
    case "waiting":
      // Decided, but the worker has not carried it out yet.
      if (step.decidedBy) return { tone: "wait", icon: "clock", text: `${step.resolution === "rejected" ? "Denied" : "Approved"} by ${step.decidedBy}, waiting to resume` };
      return { tone: "wait", icon: "clock", text: WAITING_ON[step.tool] ?? "Waiting for approval" };
    case "denied":
      if (step.decidedBy) return { tone: "deny", icon: "ban", text: `Denied by ${step.decidedBy}`, reason: step.reason, note: step.reason };
      return { tone: "deny", icon: "ban", text: "Not allowed", reason: step.reason };
    case "failed":
      return { tone: "deny", icon: "alert", text: "Failed", reason: step.reason };
    case "skipped":
      // Only an approver's refusal skips a step in this demo, and what was refused names the outcome.
      return { tone: "muted", icon: "minus", text: SKIPPED[step.tool] ?? "Skipped", reason: step.reason };
    case "pending":
      return { tone: "muted", icon: "circle", text: "Pending" };
  }
}

export type Summary = { tone: "ok" | "warn" | "bad"; title: string; body: string };

/**
 * The run summary, derived only from step statuses (never from run.state). "All set" is claimed only when
 * all nine steps are done; otherwise the body counts what actually happened. Null before anything has run.
 */
export function summarize(run: Run, seconds: number | null): Summary | null {
  const count = (s: Step["status"]) => run.steps.filter((x) => x.status === s).length;
  const total = run.steps.length;
  const done = count("done");
  const pending = count("pending");
  if (pending === total) return null;

  if (done === total) {
    const title = seconds === null ? "All set" : `All set in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
    const approved = run.steps.filter((s) => s.approvalId).length;
    const after = approved === 0 ? "Nobody had to touch a thing." : `${approved} approved by a person.`;
    return { tone: "ok", title, body: `${total} of ${total} steps finished. ${after}` };
  }

  const waiting = count("waiting");
  const refused = run.steps.filter((s) => s.status === "denied" && s.decidedBy).length;
  const denied = count("denied") - refused;
  const failed = count("failed");
  const skipped = count("skipped");
  const parts = [
    done && `${done} finished`,
    waiting && `${waiting} waiting on people`,
    denied && `${denied} not allowed`,
    refused && `${refused} denied by a person`,
    failed && `${failed} failed`,
    skipped && `${skipped} skipped`,
    pending && `${pending} still to go`,
  ].filter(Boolean);
  return {
    tone: failed ? "bad" : "warn",
    title: failed ? "Needs attention" : pending ? "In progress" : waiting ? "Waiting on people" : "Finished with exceptions",
    body: parts.join(", "),
  };
}
