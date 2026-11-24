import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Proposal } from "../lib/proposal";
import { ProposalPanelView } from "./ProposalPanel";

const proposal: Proposal = {
  id: "p1",
  actionDigest: "d",
  state: "pending",
  agent: "Fernhill Desk",
  principal: "svc_adapter",
  policyCount: 3,
  unrecognized: [],
  rules: [
    { tool: "slack_invite", mode: "always_allow", rationale: "One invite, revocable", sideEffect: "external", description: null, inputSchema: null },
    { tool: "mercury_issue_card", mode: "ask", rationale: "Commits money", sideEffect: "external", description: null, inputSchema: null },
    { tool: "okta_assign_admin_role", mode: "deny", rationale: "Never", sideEffect: "admin", description: null, inputSchema: null },
  ],
};
const render = (p: Proposal | null, message: string | null = null) => renderToStaticMarkup(<ProposalPanelView proposal={p} busy={false} message={message} onApprove={vi.fn()} />);

describe("ProposalPanelView", () => {
  it("is dormant with no proposal", () => {
    expect(render(null)).toBe("");
  });
  it("groups the tools by what the rule does, with counts and an Approve button", () => {
    const html = render(proposal);
    expect(html).toContain("Fernhill Desk asks to run under these rules");
    expect(html).toContain("Runs freely (1)");
    expect(html).toContain("Asks a person (1)");
    expect(html).toContain("Never allowed (1)");
    expect(html).toContain("Slack and team channels");
    expect(html).toContain("Approve rules");
    expect(html).toContain("One invite, revocable");
  });
  it("shows each tool's side effect level from the proposal, so the approver sees the assessment", () => {
    const html = render(proposal);
    expect(html).toContain("external");
    expect(html).toContain("admin");
  });
  it("has a collapsed Details per tool with the proposal's description and input schema", () => {
    const rule = { ...proposal.rules[0], description: "Invite the new hire", inputSchema: { type: "object", properties: { email: { type: "string" } } } };
    const html = render({ ...proposal, policyCount: 1, rules: [rule] });
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("<summary>Details</summary>");
    expect(html).toContain("Invite the new hire");
    expect(html).toContain("&quot;email&quot;");
  });
  it("leaves out a group with no rules", () => {
    expect(render({ ...proposal, policyCount: 1, rules: [proposal.rules[0]] })).not.toContain("Never allowed");
  });
  it("after approval shows the rules in force and who approved, with no button", () => {
    const html = render({ ...proposal, state: "approved", decidedBy: "Admin" });
    expect(html).toContain("Rules in force");
    expect(html).toContain("Approved by Admin");
    expect(html).not.toContain("Approve rules");
  });
  it("shows a refusal inline", () => {
    expect(render(proposal, "The proposal was refused")).toContain("The proposal was refused");
  });
  it("carries no token", () => {
    expect(render(proposal)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
  const approveDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Approve rules/s.test(html);
  it("Approve is enabled for a fully recognized proposal, and it names who the agent runs as", () => {
    const html = render(proposal);
    expect(approveDisabled(html)).toBe(false);
    expect(html).toContain("svc_adapter");
    expect(html).not.toContain('data-testid="proposal-unrecognized"');
  });
  it("shows an unrecognized value raw with a warning and disables Approve", () => {
    const html = render({ ...proposal, unrecognized: ['{"targets":{"tools":["ext:other:slack_invite"]}}'] });
    expect(html).toContain('data-testid="proposal-unrecognized"');
    expect(html).toContain("ext:other:slack_invite");
    expect(approveDisabled(html)).toBe(true);
  });
  it("disables Approve when the rules shown differ from the rules in the proposal", () => {
    const html = render({ ...proposal, policyCount: 4 });
    expect(html).toContain('data-testid="proposal-unrecognized"');
    expect(html).toContain("3 of 4");
    expect(approveDisabled(html)).toBe(true);
  });
});
