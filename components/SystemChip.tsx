import type { Vendor } from "@/lib/seed";

const CHIP: Record<Vendor, { cls: string; initials: string; label: string }> = {
  okta: { cls: "okta", initials: "Ok", label: "Okta" },
  google: { cls: "goog", initials: "G", label: "Google Workspace" },
  slack: { cls: "slack", initials: "Sl", label: "Slack" },
  cdw: { cls: "cdw", initials: "CD", label: "CDW" },
  merch: { cls: "merch", initials: "Mr", label: "Merch" },
  print: { cls: "print", initials: "Pr", label: "Print" },
  adp: { cls: "adp", initials: "AD", label: "ADP" },
  mercury: { cls: "merc", initials: "Mc", label: "Mercury" },
};

/** Initials on a colored tile; deliberately never a real logo. */
export function SystemChip({ vendor }: { vendor: Vendor }) {
  const c = CHIP[vendor];
  return (
    <span className={`sys ${c.cls}`} title={c.label} aria-hidden="true">
      {c.initials}
    </span>
  );
}

/** Same tile for vendors outside the eight the agent touches. */
export function NeutralChip({ initials }: { initials: string }) {
  return (
    <span className="sys neutral" aria-hidden="true">
      {initials}
    </span>
  );
}
