import { Bot } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { dayLabel, seed } from "@/lib/seed";

export default function AgentsPage() {
  const today = new Date();
  return (
    <AppShell active="agents">
      <PageHeader crumb="Automation / Agents" title="Agents" subtitle={`${seed.agents.length} agents handling routine work across your tools`} />
      <table>
        <thead><tr><th>Agent</th><th>What it does</th><th>Owner</th><th className="num">Runs, 30 days</th><th>Last run</th><th>Status</th></tr></thead>
        <tbody>
          {seed.agents.map((a) => (
            <tr key={a.id}>
              <td><div className="cell"><Bot className="muted" /><span className="strong">{a.name}</span></div></td>
              <td style={{ maxWidth: 380 }}>{a.description}</td>
              <td>{a.owner}</td>
              <td className="num">{a.runs30d}</td>
              <td>{dayLabel(today, a.lastRunDaysAgo)}</td>
              <td><span className="chip green">{a.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppShell>
  );
}
