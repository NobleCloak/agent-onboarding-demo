/**
 * The agent under governance. The app and the resumer worker both build it here, so a paused run resumes on the
 * same agent that paused it. `buildAgent` already carries the SQLite checkpointer they share.
 */
import type { Governance } from "@noblecloak/langgraph";
import { governanceMiddleware } from "@noblecloak/langgraph/middleware";
import { buildAgent } from "../agent/agent";
import { TOOL_NAMES, type ToolName } from "../run/types";

/** LangChain tool name to catalog `tool_ref`. A tool the agent carries that is missing here fails the run. */
export const TOOL_REFS = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, `ext:fernhill-desk:${name}`]),
) as Record<ToolName, string>;

export function buildGovernedAgent(governance: Governance) {
  return buildAgent({ middleware: [governanceMiddleware(governance, { toolRefs: TOOL_REFS })] });
}
