import { z } from "zod";
import { updateSteps } from "./store";
import { TOOL_NAMES, type Step, type ToolName } from "./types";

// Turns what a governed agent run returned into step states. The tools write their own `done`; this file writes
// everything else: `waiting` (interrupts), `denied` (a rule or an approver refused) and `failed` (a governance or
// tool error). A step only moves forward: done stays done and a refusal stays a refusal, because a checkpoint read
// mid-turn still lists the interrupts of calls that have since been resumed.

const InterruptValue = z.object({ approval_id: z.string().min(1), tool_ref: z.string() });
const Interrupt = z.object({ value: InterruptValue });

/** `@noblecloak/langgraph` marks a call it did not run with its code under this key (`DENIAL_KEY`). */
const Denial = z.object({ noblecloak: z.object({ code: z.string() }) });

/** Refused by a rule or by an approver. Every other code is something going wrong, which is shown as a failure. */
const REFUSAL_CODES = new Set(["denied", "rejected"]);
/** Not an outcome: the call was held back because another call in its turn is waiting, and it runs afterwards. */
const HELD_CODE = "approval_pending_in_task";

const TOOL_PREFIX = "ext:fernhill-desk:";
const isTool = (name: unknown): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name as string);
/** A tool message carries the LangChain name. An interrupt carries the catalog ref, which must be this app's. */
const toolOfRef = (ref: string): ToolName | null => {
  const name = ref.startsWith(TOOL_PREFIX) ? ref.slice(TOOL_PREFIX.length) : null;
  return isTool(name) ? name : null;
};

type ToolOutcome = { tool: ToolName; content: string; code: string | undefined };

/** The error ToolMessages in a result. Accepts both message instances and the plain form of a stored message. */
function failedCalls(messages: unknown): ToolOutcome[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((raw: unknown): ToolOutcome[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const m = raw as { getType?: () => string; type?: unknown; name?: unknown; status?: unknown; content?: unknown; additional_kwargs?: unknown };
    const type = typeof m.getType === "function" ? m.getType() : m.type;
    const tool = m.name;
    if (type !== "tool" || m.status !== "error" || !isTool(tool)) return [];
    const denial = Denial.safeParse(m.additional_kwargs);
    return [{ tool, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content), code: denial.success ? denial.data.noblecloak.code : undefined }];
  });
}

function waitingCalls(interrupts: unknown): { tool: ToolName; approvalId: string }[] {
  if (!Array.isArray(interrupts)) return [];
  return interrupts.flatMap((raw: unknown) => {
    const parsed = Interrupt.safeParse(raw);
    if (!parsed.success) return [];
    const tool = toolOfRef(parsed.data.value.tool_ref);
    return tool ? [{ tool, approvalId: parsed.data.value.approval_id }] : [];
  });
}

const settled = (s: Step) => s.status === "done" || s.status === "denied" || s.status === "failed" || s.status === "skipped";

/**
 * Apply one agent result to the run. `result` is what `invoke` returned or the same shape read from the checkpoint:
 * `{ messages, __interrupt__ }`. A write for a run that is no longer current is dropped, so an earlier run's pending
 * approval can never mark a step in this one. A fully completed result changes nothing.
 */
export function reconcile(result: unknown, runId: string): void {
  if (typeof result !== "object" || result === null) return;
  const { messages, __interrupt__ } = result as { messages?: unknown; __interrupt__?: unknown };
  const failed = failedCalls(messages);
  const waiting = waitingCalls(__interrupt__);
  if (failed.length === 0 && waiting.length === 0) return;

  updateSteps(runId, (steps) => {
    const find = (tool: ToolName) => steps.find((s) => s.tool === tool);
    for (const call of failed) {
      const step = find(call.tool);
      if (!step || settled(step) || call.code === HELD_CODE) continue;
      step.status = call.code !== undefined && REFUSAL_CODES.has(call.code) ? "denied" : "failed";
      // An approver's own reason, already read from the approval, is what the page shows. The tool message's wording varies.
      if (!step.decidedBy) step.reason = call.content;
    }
    for (const call of waiting) {
      const step = find(call.tool);
      if (!step || settled(step)) continue;
      step.status = "waiting";
      step.approvalId = call.approvalId;
    }
  });
}
