import { AppShell } from "@/components/AppShell";
import { Avatar } from "@/components/Avatar";
import { PageHeader } from "@/components/PageHeader";
import { addDays, formatShort, person, seed } from "@/lib/seed";

export default function TimeOffPage() {
  const today = new Date();
  const rows = [...seed.timeOff].sort((a, b) => a.fromInDays - b.fromInDays);
  return (
    <AppShell active="timeoff">
      <PageHeader crumb="People / Time off" title="Time off" subtitle={`${rows.filter((r) => r.status === "Pending").length} requests waiting on a manager`} />
      <table>
        <thead><tr><th>Person</th><th>Team</th><th>Type</th><th>Starts</th><th>Ends</th><th className="num">Days</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const p = person(r.personId);
            const from = addDays(today, r.fromInDays);
            const to = addDays(from, r.days - 1);
            return (
              <tr key={r.id}>
                <td><div className="cell"><Avatar name={p.name} /><span className="strong">{p.name}</span></div></td>
                <td>{p.dept}</td>
                <td>{r.kind}</td>
                <td>{formatShort(from)}</td>
                <td>{formatShort(to)}</td>
                <td className="num">{r.days}</td>
                <td><span className={r.status === "Pending" ? "chip amber" : "chip green"}>{r.status}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </AppShell>
  );
}
