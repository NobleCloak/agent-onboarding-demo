export const TOOL_NAMES = [
  "okta_create_user",
  "google_create_account",
  "slack_invite",
  "cdw_order_laptop",
  "merch_order_polos",
  "print_order_business_cards",
  "adp_create_employee",
  "mercury_issue_card",
  "okta_assign_admin_role",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type StepStatus = "pending" | "done" | "waiting" | "denied" | "failed" | "skipped";

export type Step = {
  tool: ToolName;
  status: StepStatus;
  args?: unknown;
  /** Display value for the screen, for example "Limit $25,000 / month". */
  detail?: string;
  approvalId?: string;
  reason?: string;
  /** The approver's display name and decision, read from the approval's resolution_history. */
  decidedBy?: string;
  resolution?: "approved" | "rejected";
};

export type RunState = "idle" | "running" | "parked" | "finished";

export type Run = {
  id: string;
  startedAt: string;
  state: RunState;
  steps: Step[];
};
