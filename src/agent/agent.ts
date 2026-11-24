import { AIMessage } from "@langchain/core/messages";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createAgent, type AgentMiddleware } from "langchain";
import { checkpointFile, openDb } from "../run/store";
import type { ToolName } from "../run/types";
import { ScriptedModel } from "./model";
import { TOOLS } from "./tools";

export { TOOLS };

export const PROMPT = "Maya starts Monday as Marketing Coordinator. Same setup as Dana.";

const call = (id: string, name: ToolName, args: Record<string, unknown>) => ({ id, name, args, type: "tool_call" as const });

/** Three scripted turns (accounts, desk items, money and access in one message), then a closing message. */
export const SCRIPT: AIMessage[] = [
  new AIMessage({
    content: "",
    tool_calls: [
      call("c1", "okta_create_user", { name: "Maya Torres", username: "maya.torres" }),
      call("c2", "google_create_account", { email: "maya.torres@fernhill.co" }),
      call("c3", "slack_invite", { email: "maya.torres@fernhill.co" }),
    ],
  }),
  new AIMessage({
    content: "",
    tool_calls: [
      call("c4", "cdw_order_laptop", { model: "Laptop 14", ship_to: "Portland office" }),
      call("c5", "merch_order_polos", { quantity: 3, recipient: "Maya Torres" }),
      call("c6", "print_order_business_cards", { quantity: 250, name: "Maya Torres" }),
    ],
  }),
  new AIMessage({
    content: "",
    tool_calls: [
      call("c7", "adp_create_employee", {
        employee: "Maya Torres",
        title: "Marketing Coordinator",
        salary_source: "copied from Dana Whitfield",
      }),
      call("c8", "mercury_issue_card", {
        cardholder: "Maya Torres",
        limit_monthly: 25000,
        copied_from: "Dana Whitfield",
        account: "Mercury Ops ••4471",
      }),
      call("c9", "okta_assign_admin_role", { user: "maya.torres", role: "org_admin" }),
    ],
  }),
  new AIMessage("Maya Torres is set up with the same access and budget as Dana."),
];

/**
 * Build the agent. The app and a separate worker process each call this; both reach the same checkpoint file.
 * Governed wiring passes its middleware in here.
 */
export function buildAgent(options: { middleware?: AgentMiddleware[] } = {}) {
  return createAgent({
    model: new ScriptedModel(SCRIPT),
    tools: TOOLS,
    version: "v2",
    middleware: options.middleware ?? [],
    checkpointer: new SqliteSaver(openDb(checkpointFile())),
  });
}
