import { OnboardingRun } from "@/components/OnboardingRun";
import { currentMode } from "@/lib/mode";
import { firstPaint } from "@/lib/run-view";
import { formatLong, person, seed, seedDates } from "@/lib/seed";
import { getRun } from "../../../../src/run/store";

export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  const { start } = seedDates(new Date());
  const maya = person("maya-torres");
  const manager = person(maya.managerId ?? "");
  const ticketFrom = person(seed.ticket.from);
  const request = seed.inbox.find((m) => m.id === "i1");
  return (
    <OnboardingRun
      initialRun={firstPaint(getRun(), currentMode())}
      subtitle={`${maya.title} · Starts ${formatLong(start)} · Reports to ${manager.name}`}
      ticket={{ from: `${ticketFrom.name}, People Ops`, time: request?.time ?? "9:12 AM", text: seed.ticket.text }}
    />
  );
}
