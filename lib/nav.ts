export type NavKey =
  | "home"
  | "inbox"
  | "directory"
  | "onboarding"
  | "timeoff"
  | "vendors"
  | "purchasing"
  | "itrequests"
  | "agents"
  | "tools"
  | "permissions";

export type NavItem = { key: NavKey; label: string; href: string; count?: number };
export type NavSection = { title?: string; items: NavItem[] };

export const navSections: NavSection[] = [
  {
    items: [
      { key: "home", label: "Home", href: "/" },
      { key: "inbox", label: "Inbox", href: "/inbox", count: 4 },
    ],
  },
  {
    title: "People",
    items: [
      { key: "directory", label: "Directory", href: "/people/directory" },
      { key: "onboarding", label: "Onboarding", href: "/people/onboarding/maya-torres", count: 3 },
      { key: "timeoff", label: "Time off", href: "/people/time-off" },
    ],
  },
  {
    title: "Operations",
    items: [
      { key: "vendors", label: "Vendors", href: "/operations/vendors" },
      { key: "purchasing", label: "Purchasing", href: "/operations/purchasing" },
      { key: "itrequests", label: "IT requests", href: "/operations/it-requests", count: 12 },
    ],
  },
  {
    title: "Automation",
    items: [
      { key: "agents", label: "Agents", href: "/automation/agents" },
      { key: "tools", label: "Tools", href: "/automation/tools" },
      { key: "permissions", label: "Permissions", href: "/automation/permissions" },
    ],
  },
];
