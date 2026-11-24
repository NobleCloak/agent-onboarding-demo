import { CalendarClock, ClipboardCheck, LifeBuoy, Plus, Receipt } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { NeutralChip, SystemChip } from "@/components/SystemChip";
import { dayLabel, formatLong, formatShort, addDays, person, seed, seedDates, usd } from "@/lib/seed";

export default function HomePage() {
  const today = new Date();
  const { start } = seedDates(today);
  const me = person(seed.currentUserId);
  const hour = today.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const out = seed.timeOff.filter((t) => t.fromInDays <= 0 && t.fromInDays + t.days > 0);
  const renewals = seed.vendors.filter((v) => v.renewsInDays <= 60).sort((a, b) => a.renewsInDays - b.renewsInDays);
  const open = seed.itRequests;

  return (
    <AppShell active="home">
      <PageHeader
        crumb={formatLong(today)}
        title={`${greeting}, ${me.name.split(" ")[0]}`}
        subtitle={`${seed.org} · ${me.title}`}
        actions={
          <button className="btn alt" type="button">
            <Plus /> New request
          </button>
        }
      />
      <div className="cards">
        <div className="card"><div className="k">Open IT requests</div><div className="v">{open.length}</div><div className="s">{open.filter((r) => r.priority === "High").length} marked high priority</div></div>
        <div className="card"><div className="k">Onboarding</div><div className="v">3</div><div className="s">Next start {formatShort(start)}</div></div>
        <div className="card"><div className="k">Renewals, 60 days</div><div className="v">{renewals.length}</div><div className="s">{usd(renewals.reduce((n, v) => n + v.annualUsd, 0))} annual value</div></div>
        <div className="card"><div className="k">Out today</div><div className="v">{out.length}</div><div className="s">{seed.people.length} people on the roster</div></div>
      </div>

      <div className="cols">
        <section>
          <div className="h3">Needs your attention</div>
          <div className="row">
            <ClipboardCheck className="muted" />
            <div className="n"><div>Maya Torres starts {formatShort(start)}</div><div className="mono">Onboarding checklist not started</div></div>
            <span className="chip amber">Due this week</span>
          </div>
          <div className="row">
            <Receipt className="muted" />
            <div className="n"><div>Two purchase orders waiting on approval</div><div className="mono">PO-2288, PO-2287</div></div>
            <span className="chip amber">{usd(4800 + 2388)}</span>
          </div>
          <div className="row">
            <LifeBuoy className="muted" />
            <div className="n"><div>{seed.itRequests[0].title}</div><div className="mono">{seed.itRequests[0].id}</div></div>
            <span className="chip red">High</span>
          </div>
          <div className="row">
            <CalendarClock className="muted" />
            <div className="n"><div>Time off requests pending</div><div className="mono">{seed.timeOff.filter((t) => t.status === "Pending").length} waiting on a manager</div></div>
            <span className="chip">Review</span>
          </div>

          <div className="h3" style={{ marginTop: 22 }}>Recent activity</div>
          {seed.inbox.slice(0, 5).map((m) => (
            <div className="row" key={m.id}>
              <div className="n"><div>{m.subject}</div><div className="mono">{m.from}</div></div>
              <span className="val">{dayLabel(today, m.daysAgo)}</span>
            </div>
          ))}
        </section>

        <section>
          <div className="h3">Upcoming renewals</div>
          {renewals.map((v) => (
            <div className="row" key={v.name}>
              {v.vendor ? <SystemChip vendor={v.vendor} /> : <NeutralChip initials={v.initials} />}
              <div className="n"><div>{v.name}</div><div className="mono">{v.category}</div></div>
              <span className="val"><b>{formatShort(addDays(today, v.renewsInDays))}</b></span>
            </div>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
