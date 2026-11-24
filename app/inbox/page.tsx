import { Filter } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Avatar } from "@/components/Avatar";
import { PageHeader } from "@/components/PageHeader";
import { dayLabel, seed } from "@/lib/seed";

export default function InboxPage() {
  const today = new Date();
  const unread = seed.inbox.filter((m) => m.unread).length;
  return (
    <AppShell active="inbox">
      <PageHeader
        crumb="Inbox"
        title="Inbox"
        subtitle={`${unread} unread of ${seed.inbox.length} recent messages`}
        actions={<button className="btn alt" type="button"><Filter /> Filter</button>}
      />
      <table>
        <thead><tr><th style={{ width: 18 }} /><th>From</th><th>Message</th><th>Received</th></tr></thead>
        <tbody>
          {seed.inbox.map((m) => (
            <tr key={m.id}>
              <td><span className={m.unread ? "dot-u" : "dot-u off"} /></td>
              <td><div className="cell"><Avatar name={m.from} /><span className={m.unread ? "unread" : ""}>{m.from}</span></div></td>
              <td><span className={m.unread ? "unread" : ""}>{m.subject}</span> <span className="muted"> {m.preview}</span></td>
              <td className="val">{dayLabel(today, m.daysAgo)}, {m.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppShell>
  );
}
