import type { Summary } from "../lib/steps";

export function RunSummary({ summary }: { summary: Summary }) {
  return (
    <div className={summary.tone === "ok" ? "ok" : `ok ${summary.tone}`} role="status" data-testid="run-summary">
      <b>{summary.title}</b>
      {summary.body}
    </div>
  );
}
