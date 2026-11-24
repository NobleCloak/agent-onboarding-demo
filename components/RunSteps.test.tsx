import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Run, Step, StepStatus, ToolName } from "../src/run/types";
import { TOOL_NAMES } from "../src/run/types";
import { RunSteps } from "./RunSteps";

function makeRun(statuses: Partial<Record<ToolName, StepStatus | Partial<Step>>> = {}, state: Run["state"] = "finished"): Run {
  return {
    id: "run-1",
    startedAt: "2026-11-02T09:00:00.000Z",
    state,
    steps: TOOL_NAMES.map((tool) => {
      const v = statuses[tool];
      const patch = typeof v === "string" ? { status: v } : (v ?? {});
      return { tool, status: "pending" as StepStatus, ...patch };
    }),
  };
}

/** The markup of one row, found by its tool name. */
function row(html: string, tool: ToolName): string {
  const m = html.match(new RegExp(`<div class="row[^"]*" data-tool="${tool}".*?(?=<div class="row|<div class="grp|$)`, "s"));
  if (!m) throw new Error(`no row for ${tool}`);
  return m[0];
}
const render = (run: Run) => renderToStaticMarkup(<RunSteps run={run} />);

describe("RunSteps", () => {
  it("groups the nine steps under the three headings", () => {
    const html = render(makeRun());
    for (const g of ["Accounts", "On the way to her desk", "Money and access"]) expect(html).toContain(g);
    expect(html.match(/data-tool=/g)).toHaveLength(9);
  });

  it("renders Waiting for HR and Waiting for Finance", () => {
    const html = render(makeRun({ adp_create_employee: "waiting", mercury_issue_card: "waiting" }, "parked"));
    expect(row(html, "adp_create_employee")).toContain("Waiting for HR");
    expect(row(html, "mercury_issue_card")).toContain("Waiting for Finance");
  });

  it("renders Not allowed for a denied call, with the reason accessible", () => {
    const html = render(makeRun({ okta_assign_admin_role: { status: "denied", reason: "Admin roles are never granted by an agent" } }));
    const r = row(html, "okta_assign_admin_role");
    expect(r).toContain("Not allowed");
    expect(r).toContain("Admin roles are never granted by an agent");
    expect(r).not.toContain("Done");
  });

  it("names the person and shows their reason on a call a person denied", () => {
    const html = render(makeRun({ mercury_issue_card: { status: "denied", decidedBy: "Sam Okoye", reason: "Not this month" } }));
    expect(html).toContain("Denied by Sam Okoye");
    expect(html).toContain("Not this month");
  });

  it("a decided call the worker has not carried out says so instead of still asking the team", () => {
    const html = render(makeRun({ adp_create_employee: { status: "waiting", decidedBy: "Priya Shah", resolution: "approved" } }));
    expect(html).toContain("Approved by Priya Shah, waiting to resume");
    expect(html).not.toContain("Waiting for HR");
  });

  it("renders a failed step as failed, never Done", () => {
    const html = render(makeRun({ cdw_order_laptop: { status: "failed", reason: "Agent error: boom" } }));
    const r = row(html, "cdw_order_laptop");
    expect(r).toContain("Failed");
    expect(r).toContain("Agent error: boom");
    expect(r).not.toContain("Done");
  });

  it("renders slack_invite as waiting when that is what the run reports", () => {
    const html = render(makeRun({ slack_invite: "waiting" }, "parked"));
    const r = row(html, "slack_invite");
    expect(r).toContain("Waiting for approval");
    expect(r).not.toContain("Done");
  });

  it("shows detail values only for done rows in Money and access", () => {
    const html = render(
      makeRun({
        okta_create_user: { status: "done", detail: "Account maya.torres" },
        mercury_issue_card: { status: "done", detail: "Limit $25,000 / month" },
        okta_assign_admin_role: { status: "done", detail: "Role Org admin" },
        adp_create_employee: { status: "done", detail: "Salary copied from Dana" },
      }),
    );
    expect(row(html, "mercury_issue_card")).toContain("<b>$25,000 / month</b>");
    expect(row(html, "okta_assign_admin_role")).toContain("<b>Org admin</b>");
    expect(row(html, "adp_create_employee")).toContain("<b>copied from Dana</b>");
    expect(row(html, "okta_create_user")).not.toContain("maya.torres");
  });

  it("words skipped rows by what was refused", () => {
    const html = render(makeRun({ mercury_issue_card: "skipped", adp_create_employee: "skipped", slack_invite: "skipped" }));
    expect(row(html, "mercury_issue_card")).toContain("Not issued");
    expect(row(html, "adp_create_employee")).toContain("Not created");
    expect(row(html, "slack_invite")).toContain("Skipped");
  });

  it("shows pending rows as not done", () => {
    const html = render(makeRun({}, "idle"));
    expect(html).not.toContain("Done");
  });
});
