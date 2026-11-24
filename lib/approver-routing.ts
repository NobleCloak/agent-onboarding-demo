import type { ToolName } from "../src/run/types";

// Fernhill's approver routing: which team decides a call to a tool when its rule asks. A team is a NobleCloak role
// key. No imports beyond types, so the app, the panel and the local mock's shim (scripts/noblecloak-local.ts) share it.

export type Team = "hr" | "finance";
export const TEAM_LABEL: Record<Team, string> = { hr: "HR", finance: "Finance" };

/** A tool that is not listed has no named approvers. */
export const APPROVER_TEAM: Partial<Record<ToolName, Team>> = { adp_create_employee: "hr", mercury_issue_card: "finance" };

/** The team each demo approver belongs to: the role their token carries. */
export const PERSONA_TEAM = { priya: "finance", sam: "hr" } as const satisfies Record<string, Team>;
