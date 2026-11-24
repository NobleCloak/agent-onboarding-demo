import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { dayLabel, seed } from "@/lib/seed";

const prio = (p: string) => (p === "High" ? "chip red" : p === "Low" ? "chip" : "chip amber");

export default function ItRequestsPage() {
  const today = new Date();
  return (
    <AppShell active="itrequests">
      <PageHeader crumb="Operations / IT requests" title="IT requests" subtitle={`${seed.itRequests.length} open requests`} />
      <table>
        <thead><tr><th>ID</th><th>Request</th><th>Requested by</th><th>Assigned to</th><th>Priority</th><th>Status</th><th>Opened</th></tr></thead>
        <tbody>
          {seed.itRequests.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td className="strong">{r.title}</td>
              <td>{r.requester}</td>
              <td>{r.assignee}</td>
              <td><span className={prio(r.priority)}>{r.priority}</span></td>
              <td>{r.status}</td>
              <td>{dayLabel(today, r.daysAgo)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppShell>
  );
}
