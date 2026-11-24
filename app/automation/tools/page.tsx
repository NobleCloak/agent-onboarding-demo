import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { SystemChip } from "@/components/SystemChip";
import { seed, toolCount } from "@/lib/seed";
import type { Vendor } from "@/lib/seed";

export default function ToolsPage() {
  const entries = Object.entries(seed.toolsByVendor) as [Vendor, { system: string; tools: string[] }][];
  return (
    <AppShell active="tools">
      <PageHeader crumb="Automation / Tools" title="Tools" subtitle={`${toolCount()} tools across ${entries.length} connected systems`} />
      <div className="toolgrid">
        {entries.map(([vendor, { system, tools }]) => (
          <div className="tg" key={vendor}>
            <div className="row" style={{ borderBottom: "none", paddingBottom: 2 }}>
              <SystemChip vendor={vendor} />
              <div className="n"><div>{system}</div></div>
              <span className="val">{tools.length} tools</span>
            </div>
            {tools.map((t) => (
              <div className="row" key={t}><div className="n"><div className="tool">{vendor}.{t}</div></div></div>
            ))}
          </div>
        ))}
      </div>
    </AppShell>
  );
}
