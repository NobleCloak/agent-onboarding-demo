import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { setStep } from "../run/store";
import { TOOL_NAMES, type ToolName } from "../run/types";

type Def = { schema: z.ZodType<Record<string, unknown>>; detail: (args: any) => string; result: string };

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const titleCase = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const DEFS: Record<ToolName, Def> = {
  okta_create_user: {
    schema: z.object({ name: z.string(), username: z.string() }),
    detail: (a) => `Account ${a.username}`,
    result: "Okta user created",
  },
  google_create_account: {
    schema: z.object({ email: z.string() }),
    detail: (a) => a.email,
    result: "Google Workspace account created",
  },
  slack_invite: {
    schema: z.object({ email: z.string() }),
    detail: (a) => `Invited ${a.email}`,
    result: "Slack invite sent",
  },
  cdw_order_laptop: {
    schema: z.object({ model: z.string(), ship_to: z.string() }),
    detail: (a) => `${a.model}, ships to ${a.ship_to}`,
    result: "CDW order placed",
  },
  merch_order_polos: {
    schema: z.object({ quantity: z.number(), recipient: z.string() }),
    detail: (a) => `${a.quantity} polos`,
    result: "Pennant & Co. order placed",
  },
  print_order_business_cards: {
    schema: z.object({ quantity: z.number(), name: z.string() }),
    detail: (a) => `${a.quantity} cards`,
    result: "Harbor Print Works order placed",
  },
  adp_create_employee: {
    schema: z.object({ employee: z.string(), title: z.string(), salary_source: z.string() }),
    detail: (a) => `Salary ${String(a.salary_source).replace(/^copied from (\w+) .*$/, "copied from $1")}`,
    result: "ADP employee record created",
  },
  mercury_issue_card: {
    schema: z.object({
      cardholder: z.string(),
      limit_monthly: z.number(),
      copied_from: z.string(),
      account: z.string(),
    }),
    detail: (a) => `Limit ${usd(a.limit_monthly)} / month`,
    result: "Mercury card issued",
  },
  okta_assign_admin_role: {
    schema: z.object({ user: z.string(), role: z.string() }),
    detail: (a) => `Role ${titleCase(a.role)}`,
    result: "Okta admin role assigned",
  },
};

const stepMs = () => {
  const n = Number(process.env.FERNHILL_STEP_MS ?? 450);
  return Number.isFinite(n) && n >= 0 ? n : 450;
};
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Each tool writes its own `done` step, in the tool body only. A step shows done only if the call really ran,
 * including when a worker runs it after an approval.
 */
export const TOOLS = TOOL_NAMES.map((name) =>
  tool(
    async (args: Record<string, unknown>, config) => {
      const runId = config?.configurable?.thread_id;
      if (typeof runId !== "string") throw new Error(`${name}: no thread_id (run id) in the tool config`);
      await sleep(stepMs());
      setStep(runId, name, { status: "done", args, detail: DEFS[name].detail(args) });
      return DEFS[name].result;
    },
    { name, description: `Fernhill Desk: ${name.replace(/_/g, " ")}`, schema: DEFS[name].schema },
  ),
);
