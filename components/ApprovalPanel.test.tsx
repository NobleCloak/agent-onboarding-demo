import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalView } from "../lib/approvals";
import { ApprovalPanelView, DEFAULT_DENY_REASON, nextPanelState, shouldPoll, UNREACHABLE_MESSAGE, waitingForWorker, WORKER_GRACE_MS, type PanelState, type PanelViewProps } from "./ApprovalPanel";

const card: ApprovalView = {
  id: "ap-card",
  tool: "mercury_issue_card",
  waitingOn: "finance",
  canDecide: true,
  actionDigest: "d1",
  state: "pending",
  args: { cardholder: "Maya Torres", limit_monthly: 25000, copied_from: "Dana Whitfield", account: "Mercury Ops ••4471" },
};
const payroll: ApprovalView = {
  id: "ap-pay",
  tool: "adp_create_employee",
  waitingOn: "hr",
  canDecide: true,
  actionDigest: "d2",
  state: "pending",
  args: { employee: "Maya Torres", title: "Marketing Coordinator", salary_source: "copied from Dana Whitfield" },
};

const props = (over: Partial<PanelViewProps> = {}): PanelViewProps => ({
  approvals: [payroll, card],
  persona: "priya",
  message: null,
  busyId: null,
  unreachable: false,
  reasons: {},
  onReason: vi.fn(),
  onDecide: vi.fn(),
  onSwitch: vi.fn(),
  ...over,
});
const render = (over?: Partial<PanelViewProps>) => renderToStaticMarkup(<ApprovalPanelView {...props(over)} />);

describe("ApprovalPanelView", () => {
  it("the panel shows Maya Torres, $25,000 / month, and Dana as the source", () => {
    const html = render({ approvals: [card] });
    expect(html).toContain("Maya Torres");
    expect(html).toContain("$25,000 / month");
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("Mercury Ops ••4471");
  });

  it("shows values from the returned arguments, not from seed data", () => {
    const html = render({ approvals: [{ ...card, args: { ...(card.args as object), limit_monthly: 31000, copied_from: "Elena Brandt" } }] });
    expect(html).toContain("$31,000 / month");
    expect(html).toContain("Elena Brandt");
    expect(html).not.toContain("$25,000");
    expect(html).not.toContain("Dana");
  });

  it("a request this person may not decide names who can, and offers no fields, reason or buttons", () => {
    const html = render({ approvals: [{ ...payroll, canDecide: false, args: undefined }] });
    expect(html).toContain("Create payroll record");
    expect(html).toContain("Waiting for HR");
    expect(html).toContain("Only HR can decide this. Switch to Sam.");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Deny");
    expect(html).not.toContain("Reason if denying");
    expect(html).not.toContain("Salary");
  });

  it("keeps the buttons on the request this person may decide, beside one they may not", () => {
    const html = render({ approvals: [{ ...payroll, canDecide: false, args: undefined }, card] });
    expect(html.match(/Approve/g)).toHaveLength(1);
    expect(html).toContain("$25,000 / month");
    expect(html).toContain("Only HR can decide this.");
  });

  it("in deployment mode there is nobody to switch to, so the note only names the team", () => {
    const html = render({ approvals: [{ ...card, canDecide: false, args: undefined }], hidePersona: true });
    expect(html).toContain("Only Finance can decide this.");
    expect(html).not.toContain("Switch to");
  });

  it("a request with no team that this person may not decide says so plainly", () => {
    const html = render({ approvals: [{ id: "ap-slack", tool: "slack_invite", waitingOn: null, canDecide: false, actionDigest: "d", state: "pending", args: undefined }] });
    expect(html).toContain("You are not an approver for this request.");
  });

  it("shows no row for an argument that did not come back", () => {
    const html = render({ approvals: [{ ...card, args: { cardholder: "Maya Torres" } }] });
    expect(html).toContain("Cardholder");
    expect(html).not.toContain("Limit");
    expect(html).not.toContain("Copied from");
  });

  it("labels payroll as waiting for HR and the card as waiting for Finance", () => {
    const html = render();
    expect(html).toMatch(/Create payroll record[\s\S]*Waiting for HR/);
    expect(html).toMatch(/Issue company card[\s\S]*Waiting for Finance/);
  });

  it("renders nothing when there are no approvals (dormant)", () => {
    expect(render({ approvals: [] })).toBe("");
  });

  it("one persona button says who is acting and who it switches to", () => {
    const html = render();
    expect(html.match(/data-testid="persona-switch"/g)).toHaveLength(1);
    expect(html).toContain("Priya Shah, Finance");
    expect(html).toContain("Switch to Sam");
    expect(render({ persona: "sam" })).toContain("Sam Okoye, HR");
  });

  it("offers a reason for a denial with a short default", () => {
    expect(render({ approvals: [card] })).toContain(`value="${DEFAULT_DENY_REASON}"`);
    expect(render({ approvals: [card], reasons: { "ap-card": "Over budget" } })).toContain('value="Over budget"');
  });

  it("after a decision, shows who decided by name and the reason from the approval", () => {
    const denied: ApprovalView = { ...card, state: "rejected", decision: { resolution: "rejected", by: "Sam Okoye", reason: "Not this month", at: "t" } };
    const approved: ApprovalView = { ...payroll, state: "approved", decision: { resolution: "approved", by: "Priya Shah", at: "t" } };
    const html = render({ approvals: [approved, denied] });
    expect(html).toContain("Denied by Sam Okoye: Not this month");
    expect(html).toContain("Approved by Priya Shah");
    expect(html).not.toContain("Needs approval");
    expect(html).not.toContain("Approve</button>");
  });

  it("shows an inline message as an alert", () => {
    const html = render({ message: "This request changed or was already decided. The list has been refreshed." });
    expect(html).toMatch(/role="alert"[^>]*>This request changed/);
  });

  it("disables the buttons while a decision is being sent", () => {
    const html = render({ approvals: [card], busyId: "ap-card" });
    expect(html.match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("when NobleCloak goes away", () => {
  it("keeps the cards, disables every button and says so", () => {
    const html = render({ unreachable: true });
    expect(html).toContain("Issue company card");
    expect(html).toContain(UNREACHABLE_MESSAGE);
    expect(UNREACHABLE_MESSAGE).toBe("NobleCloak unreachable. Retrying.");
    expect(html.match(/<button[^>]*disabled=""/g)!.length).toBe(5); // persona switch + 2 x (Approve, Deny)
  });

  const shown: PanelState = { persona: "sam", approvals: [card], unreachable: false };
  const empty: PanelState = { persona: "priya", approvals: [], unreachable: false };

  it("once cards were shown, an unreachable answer keeps them and flags it; the next good answer clears the flag", () => {
    const lost = nextPanelState(shown, { persona: "sam", approvals: [], reachable: false });
    expect(lost).toEqual({ persona: "sam", approvals: [card], unreachable: true });
    const back = nextPanelState(lost, { persona: "sam", approvals: [card, payroll], reachable: true });
    expect(back).toEqual({ persona: "sam", approvals: [card, payroll], unreachable: false });
  });

  it("an answer with no persona (deployment mode) keeps the panel's own and shows the approvals", () => {
    expect(nextPanelState(empty, { approvals: [card], reachable: true })).toEqual({ persona: "priya", approvals: [card], unreachable: false });
  });

  it("if the panel never had approvals, an unreachable answer stays silent", () => {
    expect(nextPanelState(empty, { persona: "priya", approvals: [], reachable: false })).toEqual(empty);
  });

  it("a reachable empty list clears the cards", () => {
    expect(nextPanelState(shown, { persona: "sam", approvals: [], reachable: true }).approvals).toEqual([]);
  });
});

describe("shouldPoll", () => {
  it("polls while a run is running or parked", () => {
    expect(shouldPoll("running", [])).toBe(true);
    expect(shouldPoll("parked", [])).toBe(true);
  });
  it("stops when the run is finished and nothing is pending; keeps going while something is", () => {
    expect(shouldPoll("finished", [])).toBe(false);
    expect(shouldPoll("finished", [{ ...card, state: "rejected" }])).toBe(false);
    expect(shouldPoll("finished", [card])).toBe(true);
  });
  it("does not poll an idle page", () => {
    expect(shouldPoll("idle", [card])).toBe(false);
  });
});

describe("wiring", () => {
  it("OnboardingRun fills the approvalPanel slot with the ApprovalPanel", () => {
    const src = readFileSync(new URL("./OnboardingRun.tsx", import.meta.url), "utf8");
    expect(src).toContain('import { ApprovalPanel } from "./ApprovalPanel"');
    expect(src).toMatch(/const approvalPanel = <ApprovalPanel run=\{run\} \/>/);
    expect(src).toContain("{approvalPanel}");
  });
  it("OnboardingRun reaches /api/run through the token-attaching fetch, never a bare fetch", () => {
    const src = readFileSync(new URL("./OnboardingRun.tsx", import.meta.url), "utf8");
    expect(src).toContain("useApiFetch()");
    expect(src).not.toMatch(/(?<![A-Za-z.])fetch\("\/api\/run"/);
    expect(src.match(/apiFetch\("\/api\/run"/g)).toHaveLength(4);
  });
});

describe("waiting for the worker", () => {
  const at = "2026-11-03T10:00:00.000Z";
  const decided: ApprovalView = { ...payroll, state: "approved", decision: { resolution: "approved", by: "Priya Shah", at } };
  const steps = (status: "waiting" | "done") => [{ tool: "adp_create_employee" as const, status }];
  const t = Date.parse(at);

  it("names a decided call whose step still waits after the grace period", () => {
    expect(waitingForWorker([decided], steps("waiting"), t + WORKER_GRACE_MS + 1)).toEqual([decided.id]);
  });
  it("gives the worker its grace period", () => {
    expect(waitingForWorker([decided], steps("waiting"), t + WORKER_GRACE_MS - 1)).toEqual([]);
  });
  it("says nothing once the call ran, or for a call nobody has decided", () => {
    expect(waitingForWorker([decided], steps("done"), t + 60_000)).toEqual([]);
    expect(waitingForWorker([payroll], steps("waiting"), t + 60_000)).toEqual([]);
  });
  it("the card says the approved call is waiting", () => {
    // The markup escapes the apostrophe in the message.
    expect(render({ approvals: [decided], stalled: [decided.id] })).toContain("Waiting for the worker");
    expect(render({ approvals: [decided], stalled: [decided.id] })).toContain("restart it with bun run reset");
    expect(render({ approvals: [decided], stalled: [] })).not.toContain("Waiting for the worker");
  });
});

describe("a tool with no team (a rule change made it ask)", () => {
  const slack: ApprovalView = { id: "ap-slack", tool: "slack_invite", waitingOn: null, canDecide: true, actionDigest: "d", state: "pending", args: { email: "maya.torres@fernhill.co" } };
  it("shows a card with its own label and arguments", () => {
    const html = render({ approvals: [slack] });
    expect(html).toContain("Slack and team channels");
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("maya.torres@fernhill.co");
  });
});
