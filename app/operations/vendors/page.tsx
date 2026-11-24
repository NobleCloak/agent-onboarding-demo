import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { NeutralChip, SystemChip } from "@/components/SystemChip";
import { addDays, formatShort, seed, usd } from "@/lib/seed";

export default function VendorsPage() {
  const today = new Date();
  const total = seed.vendors.reduce((n, v) => n + v.annualUsd, 0);
  return (
    <AppShell active="vendors">
      <PageHeader crumb="Operations / Vendors" title="Vendors" subtitle={`${seed.vendors.length} vendors · ${usd(total)} annual spend`} />
      <table>
        <thead><tr><th>Vendor</th><th>Category</th><th>Owner</th><th className="num">Annual spend</th><th>Renews</th><th>Status</th></tr></thead>
        <tbody>
          {seed.vendors.map((v) => (
            <tr key={v.name}>
              <td><div className="cell">{v.vendor ? <SystemChip vendor={v.vendor} /> : <NeutralChip initials={v.initials} />}<span className="strong">{v.name}</span></div></td>
              <td>{v.category}</td>
              <td>{v.owner}</td>
              <td className="num">{v.annualUsd ? usd(v.annualUsd) : "Usage-based"}</td>
              <td>{formatShort(addDays(today, v.renewsInDays))}</td>
              <td><span className={v.status === "Active" ? "chip green" : v.status === "Renewal due" ? "chip amber" : "chip"}>{v.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppShell>
  );
}
