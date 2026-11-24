import { Search } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Avatar } from "@/components/Avatar";
import { PageHeader } from "@/components/PageHeader";
import { person, seed } from "@/lib/seed";

export default function DirectoryPage() {
  const sorted = [...seed.people].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <AppShell active="directory">
      <PageHeader crumb="People / Directory" title="Directory" subtitle={`${sorted.length} people across ${new Set(sorted.map((p) => p.dept)).size} teams`} />
      <div className="toolbar"><div className="search"><Search /> Search people</div></div>
      <table>
        <thead><tr><th>Name</th><th>Title</th><th>Team</th><th>Manager</th><th>Location</th><th>Email</th></tr></thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.id}>
              <td><div className="cell"><Avatar name={p.name} /><span className="strong">{p.name}</span></div></td>
              <td>{p.title}</td>
              <td><span className="chip">{p.dept}</span></td>
              <td>{p.managerId ? person(p.managerId).name : "None"}</td>
              <td>{p.location}</td>
              <td className="mono">{p.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppShell>
  );
}
