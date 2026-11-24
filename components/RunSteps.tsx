import { AlertTriangle, Ban, Check, Circle, Clock, Minus, type LucideIcon } from "lucide-react";
import { GROUPS, STEP_META, stepView, toolId, type StepView } from "../lib/steps";
import type { Run, Step } from "../src/run/types";
import { SystemChip } from "./SystemChip";

const ICONS: Record<StepView["icon"], LucideIcon> = {
  check: Check,
  clock: Clock,
  ban: Ban,
  alert: AlertTriangle,
  circle: Circle,
  minus: Minus,
};

/** "Limit $25,000 / month" -> ["Limit", "$25,000 / month"], so the value reads bold as in the mockup. */
function splitDetail(detail: string): [string, string] {
  const i = detail.indexOf(" ");
  return i < 0 ? ["", detail] : [detail.slice(0, i), detail.slice(i + 1)];
}

function StepRow({ step }: { step: Step }) {
  const meta = STEP_META[step.tool];
  const view = stepView(step);
  const Icon = ICONS[view.icon];
  const flagged = step.status === "waiting" ? " hl" : step.status === "denied" || step.status === "failed" ? " hl d" : "";
  // Values are shown in "Money and access" only, where the amounts and scopes are the point.
  const showValue = step.status === "done" && meta.group === "Money and access" && step.detail;
  const [label, value] = showValue ? splitDetail(step.detail ?? "") : ["", ""];
  return (
    <div className={`row${flagged}`} data-tool={step.tool} data-status={step.status}>
      <SystemChip vendor={meta.vendor} />
      <div className="n">
        <div>{meta.label}</div>
        <div className="tool">{toolId(step.tool)}</div>
        {view.note && <div className="why">{view.note}</div>}
      </div>
      {showValue && (
        <span className="val">
          {label} <b>{value}</b>
        </span>
      )}
      <span className={`st ${view.tone}`} title={view.reason}>
        <Icon aria-hidden="true" />
        {view.text}
        {view.reason && <span className="sr">. Reason: {view.reason}</span>}
      </span>
    </div>
  );
}

export function RunSteps({ run }: { run: Run }) {
  return (
    <div role="list" aria-label="Onboarding steps">
      {GROUPS.map((group) => (
        <div key={group} role="listitem">
          <div className="grp">{group}</div>
          {run.steps
            .filter((s) => STEP_META[s.tool].group === group)
            .map((s) => (
              <StepRow key={s.tool} step={s} />
            ))}
        </div>
      ))}
    </div>
  );
}
