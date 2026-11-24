import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { dayLabel, seed, usd } from "@/lib/seed";

const tone = (s: string) => (s === "Pending approval" ? "chip amber" : s === "Delivered" ? "chip green" : "chip");

export default function PurchasingPage() {
  const today = new Date();
  const pending = seed.orders.filter((o) => o.status === "Pending approval");
  return (
    <AppShell active="purchasing">
      <PageHeader crumb="Operations / Purchasing" title="Purchasing" subtitle={`${seed.orders.length} recent orders · ${pending.length} waiting on approval`} />
      <table>
        <thead><tr><th>Order</th><th>Vendor</th><th>Item</th><th>Requested by</th><th>Placed</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {seed.orders.map((o) => (
            <tr key={o.id}>
              <td className="mono">{o.id}</td>
              <td className="strong">{o.vendorName}</td>
              <td>{o.item}</td>
              <td>{o.requester}</td>
              <td>{dayLabel(today, o.daysAgo)}</td>
              <td className="num">{usd(o.amountUsd)}</td>
              <td><span className={tone(o.status)}>{o.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppShell>
  );
}
