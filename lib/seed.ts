
export type Vendor = "okta" | "google" | "slack" | "cdw" | "merch" | "print" | "adp" | "mercury";

export type Person = {
  id: string;
  name: string;
  title: string;
  dept: string;
  managerId: string | null;
  email: string;
  location: string;
  /** Whole years of tenure, so no calendar dates are baked in. */
  tenureYears: number;
};

const people: Person[] = [
  { id: "dana-whitfield", name: "Dana Whitfield", title: "VP of Marketing", dept: "Marketing", managerId: "elena-brandt", email: "dana.whitfield@fernhill.co", location: "Portland", tenureYears: 4 },
  { id: "maya-torres", name: "Maya Torres", title: "Marketing Coordinator", dept: "Marketing", managerId: "dana-whitfield", email: "maya.torres@fernhill.co", location: "Portland", tenureYears: 0 },
  { id: "jordan-lee", name: "Jordan Lee", title: "People Operations Manager", dept: "People Ops", managerId: "sam-okoye", email: "jordan.lee@fernhill.co", location: "Portland", tenureYears: 3 },
  { id: "priya-shah", name: "Priya Shah", title: "Finance Manager", dept: "Finance", managerId: "elena-brandt", email: "priya.shah@fernhill.co", location: "Remote", tenureYears: 5 },
  { id: "sam-okoye", name: "Sam Okoye", title: "HR Director", dept: "HR", managerId: "elena-brandt", email: "sam.okoye@fernhill.co", location: "Portland", tenureYears: 6 },
  { id: "elena-brandt", name: "Elena Brandt", title: "Chief Operating Officer", dept: "Executive", managerId: null, email: "elena.brandt@fernhill.co", location: "Portland", tenureYears: 8 },
  { id: "marcus-reyes", name: "Marcus Reyes", title: "IT Systems Administrator", dept: "IT", managerId: "elena-brandt", email: "marcus.reyes@fernhill.co", location: "Portland", tenureYears: 4 },
  { id: "tessa-nguyen", name: "Tessa Nguyen", title: "Content Marketing Lead", dept: "Marketing", managerId: "dana-whitfield", email: "tessa.nguyen@fernhill.co", location: "Remote", tenureYears: 2 },
  { id: "owen-patel", name: "Owen Patel", title: "Senior Accountant", dept: "Finance", managerId: "priya-shah", email: "owen.patel@fernhill.co", location: "Remote", tenureYears: 3 },
  { id: "lucia-moretti", name: "Lucia Moretti", title: "Account Executive", dept: "Sales", managerId: "graham-ellis", email: "lucia.moretti@fernhill.co", location: "Chicago", tenureYears: 2 },
  { id: "graham-ellis", name: "Graham Ellis", title: "VP of Sales", dept: "Sales", managerId: "elena-brandt", email: "graham.ellis@fernhill.co", location: "Chicago", tenureYears: 7 },
  { id: "hana-kobayashi", name: "Hana Kobayashi", title: "Customer Success Manager", dept: "Customer Success", managerId: "graham-ellis", email: "hana.kobayashi@fernhill.co", location: "Remote", tenureYears: 1 },
  { id: "ravi-menon", name: "Ravi Menon", title: "Facilities Coordinator", dept: "Operations", managerId: "elena-brandt", email: "ravi.menon@fernhill.co", location: "Portland", tenureYears: 3 },
  { id: "claire-dubois", name: "Claire Dubois", title: "Recruiter", dept: "People Ops", managerId: "jordan-lee", email: "claire.dubois@fernhill.co", location: "Portland", tenureYears: 1 },
  { id: "ben-adeyemi", name: "Ben Adeyemi", title: "Product Designer", dept: "Product", managerId: "elena-brandt", email: "ben.adeyemi@fernhill.co", location: "Remote", tenureYears: 2 },
  { id: "nora-lindqvist", name: "Nora Lindqvist", title: "Procurement Analyst", dept: "Operations", managerId: "ravi-menon", email: "nora.lindqvist@fernhill.co", location: "Portland", tenureYears: 2 },
];

export type VendorRow = {
  /** Set for the eight systems the demo agent touches. */
  vendor?: Vendor;
  initials: string;
  name: string;
  category: string;
  owner: string;
  annualUsd: number;
  renewsInDays: number;
  status: "Active" | "Renewal due" | "In review";
};

const vendors: VendorRow[] = [
  { vendor: "okta", initials: "Ok", name: "Okta", category: "Identity", owner: "Marcus Reyes", annualUsd: 38400, renewsInDays: 142, status: "Active" },
  { vendor: "google", initials: "G", name: "Google Workspace", category: "Productivity", owner: "Marcus Reyes", annualUsd: 21600, renewsInDays: 201, status: "Active" },
  { vendor: "slack", initials: "Sl", name: "Slack", category: "Messaging", owner: "Marcus Reyes", annualUsd: 14200, renewsInDays: 58, status: "Renewal due" },
  { vendor: "cdw", initials: "CD", name: "CDW", category: "Hardware", owner: "Nora Lindqvist", annualUsd: 96500, renewsInDays: 320, status: "Active" },
  { vendor: "merch", initials: "Mr", name: "Pennant & Co. Apparel", category: "Branded merch", owner: "Nora Lindqvist", annualUsd: 7800, renewsInDays: 96, status: "Active" },
  { vendor: "print", initials: "Pr", name: "Harbor Print Works", category: "Print", owner: "Ravi Menon", annualUsd: 3100, renewsInDays: 270, status: "Active" },
  { vendor: "adp", initials: "AD", name: "ADP", category: "Payroll", owner: "Priya Shah", annualUsd: 52800, renewsInDays: 44, status: "Renewal due" },
  { vendor: "mercury", initials: "Mc", name: "Mercury", category: "Banking", owner: "Priya Shah", annualUsd: 0, renewsInDays: 340, status: "Active" },
  { initials: "Zm", name: "Zoom", category: "Video", owner: "Marcus Reyes", annualUsd: 9600, renewsInDays: 77, status: "Active" },
  { initials: "Fg", name: "Figma", category: "Design", owner: "Ben Adeyemi", annualUsd: 6480, renewsInDays: 118, status: "Active" },
  { initials: "Nt", name: "Notion", category: "Knowledge base", owner: "Jordan Lee", annualUsd: 8640, renewsInDays: 33, status: "In review" },
  { initials: "Hs", name: "HubSpot", category: "CRM", owner: "Graham Ellis", annualUsd: 41200, renewsInDays: 164, status: "Active" },
  { initials: "Br", name: "Brightline Cleaning", category: "Facilities", owner: "Ravi Menon", annualUsd: 18900, renewsInDays: 210, status: "Active" },
  { initials: "Cw", name: "Cascade Coworking", category: "Facilities", owner: "Ravi Menon", annualUsd: 27600, renewsInDays: 25, status: "Renewal due" },
];

// Day offsets from "today"; real dates are derived in seedDates / dayLabel.
const inbox = [
  { id: "i1", from: "Jordan Lee", subject: "Maya Torres: start date confirmed", preview: "Offer is signed. She starts Monday as Marketing Coordinator.", daysAgo: 0, time: "9:12 AM", unread: true },
  { id: "i2", from: "Priya Shah", subject: "Q4 vendor renewals needing sign-off", preview: "ADP and Slack both renew inside 60 days. Can you look before Friday?", daysAgo: 0, time: "8:47 AM", unread: true },
  { id: "i3", from: "Marcus Reyes", subject: "Okta: 3 stale accounts to deactivate", preview: "These belong to contractors whose engagements ended in September.", daysAgo: 1, time: "4:20 PM", unread: true },
  { id: "i4", from: "Cascade Coworking", subject: "Your renewal quote is ready", preview: "Attached is the 12-month renewal for the Portland floor, effective next month.", daysAgo: 1, time: "11:05 AM", unread: true },
  { id: "i5", from: "Sam Okoye", subject: "Benefits enrollment window", preview: "Open enrollment closes on the 15th. Reminder emails go out Thursday.", daysAgo: 2, time: "2:30 PM", unread: false },
  { id: "i6", from: "Ravi Menon", subject: "Portland badge printer is jamming again", preview: "Third time this month. Harbor Print says a roller needs replacing.", daysAgo: 3, time: "10:15 AM", unread: false },
  { id: "i7", from: "Graham Ellis", subject: "Laptop for the Chicago hire", preview: "Lucia's replacement machine arrived with a cracked hinge. Can we RMA it?", daysAgo: 4, time: "1:40 PM", unread: false },
  { id: "i8", from: "Nora Lindqvist", subject: "CDW quote QT-20418", preview: "Pricing on 6 MacBook Pro 14 units held through the end of the month.", daysAgo: 5, time: "9:02 AM", unread: false },
];

const timeOff = [
  { id: "t1", personId: "tessa-nguyen", kind: "Vacation", fromInDays: 6, days: 5, status: "Approved" },
  { id: "t2", personId: "lucia-moretti", kind: "Vacation", fromInDays: 12, days: 3, status: "Pending" },
  { id: "t3", personId: "owen-patel", kind: "Sick", fromInDays: -1, days: 2, status: "Approved" },
  { id: "t4", personId: "hana-kobayashi", kind: "Parental leave", fromInDays: 21, days: 30, status: "Approved" },
  { id: "t5", personId: "ben-adeyemi", kind: "Vacation", fromInDays: 9, days: 4, status: "Pending" },
  { id: "t6", personId: "graham-ellis", kind: "Personal", fromInDays: 3, days: 1, status: "Approved" },
  { id: "t7", personId: "ravi-menon", kind: "Vacation", fromInDays: 28, days: 10, status: "Pending" },
  { id: "t8", personId: "claire-dubois", kind: "Bereavement", fromInDays: -3, days: 3, status: "Approved" },
  { id: "t9", personId: "dana-whitfield", kind: "Vacation", fromInDays: 35, days: 7, status: "Approved" },
] as const;

const orders = [
  { id: "PO-2291", vendorName: "CDW", item: "6x MacBook Pro 14 (M-series)", amountUsd: 17394, requester: "Nora Lindqvist", status: "Ordered", daysAgo: 2 },
  { id: "PO-2290", vendorName: "Pennant & Co. Apparel", item: "Fall polo restock, 40 units", amountUsd: 1180, requester: "Ravi Menon", status: "Shipped", daysAgo: 4 },
  { id: "PO-2289", vendorName: "Harbor Print Works", item: "Business cards, 5 employees", amountUsd: 215, requester: "Jordan Lee", status: "Delivered", daysAgo: 6 },
  { id: "PO-2288", vendorName: "CDW", item: "12x USB-C docking stations", amountUsd: 2388, requester: "Marcus Reyes", status: "Pending approval", daysAgo: 1 },
  { id: "PO-2287", vendorName: "Cascade Coworking", item: "Hot desk passes, Q4", amountUsd: 4800, requester: "Ravi Menon", status: "Pending approval", daysAgo: 1 },
  { id: "PO-2286", vendorName: "Brightline Cleaning", item: "Deep clean, Portland floor", amountUsd: 950, requester: "Ravi Menon", status: "Delivered", daysAgo: 9 },
  { id: "PO-2285", vendorName: "CDW", item: "4x 27-inch monitors", amountUsd: 1796, requester: "Marcus Reyes", status: "Delivered", daysAgo: 12 },
  { id: "PO-2284", vendorName: "Pennant & Co. Apparel", item: "Onboarding kits (hoodies), 10 units", amountUsd: 640, requester: "Jordan Lee", status: "Shipped", daysAgo: 8 },
  { id: "PO-2283", vendorName: "Harbor Print Works", item: "Event signage, Chicago office", amountUsd: 480, requester: "Graham Ellis", status: "Ordered", daysAgo: 5 },
] as const;

const itRequests = [
  { id: "IT-1184", title: "Reset MFA for Hana Kobayashi", requester: "Hana Kobayashi", assignee: "Marcus Reyes", priority: "High", status: "Open", daysAgo: 0 },
  { id: "IT-1183", title: "Shared drive access for Q4 planning folder", requester: "Tessa Nguyen", assignee: "Marcus Reyes", priority: "Normal", status: "Open", daysAgo: 0 },
  { id: "IT-1182", title: "Deactivate 3 contractor accounts", requester: "Marcus Reyes", assignee: "Marcus Reyes", priority: "Normal", status: "In progress", daysAgo: 1 },
  { id: "IT-1181", title: "Replacement laptop for Lucia Moretti (cracked hinge)", requester: "Graham Ellis", assignee: "Marcus Reyes", priority: "High", status: "Waiting on vendor", daysAgo: 1 },
  { id: "IT-1180", title: "Conference room display not detecting HDMI", requester: "Ravi Menon", assignee: "Marcus Reyes", priority: "Low", status: "Open", daysAgo: 2 },
  { id: "IT-1179", title: "Add Ben Adeyemi to design tools group", requester: "Ben Adeyemi", assignee: "Marcus Reyes", priority: "Normal", status: "In progress", daysAgo: 2 },
  { id: "IT-1178", title: "Badge printer jam, Portland", requester: "Ravi Menon", assignee: "Ravi Menon", priority: "Low", status: "Waiting on vendor", daysAgo: 3 },
  { id: "IT-1177", title: "Slack guest access for agency partner", requester: "Dana Whitfield", assignee: "Marcus Reyes", priority: "Normal", status: "Open", daysAgo: 3 },
  { id: "IT-1176", title: "VPN profile for Owen Patel's new phone", requester: "Owen Patel", assignee: "Marcus Reyes", priority: "Normal", status: "Open", daysAgo: 4 },
  { id: "IT-1175", title: "Restore deleted calendar for Graham Ellis", requester: "Graham Ellis", assignee: "Marcus Reyes", priority: "High", status: "In progress", daysAgo: 4 },
  { id: "IT-1174", title: "Printer driver for Chicago office", requester: "Lucia Moretti", assignee: "Marcus Reyes", priority: "Low", status: "Open", daysAgo: 5 },
  { id: "IT-1173", title: "Set up Okta SSO for HubSpot seats", requester: "Graham Ellis", assignee: "Marcus Reyes", priority: "Normal", status: "Open", daysAgo: 6 },
] as const;

const agents = [
  { id: "onboarding", name: "Onboarding agent", description: "Sets up accounts, equipment, payroll and access for new hires from a People Ops request.", owner: "Jordan Lee", runs30d: 14, lastRunDaysAgo: 9, status: "Active" },
  { id: "it-request", name: "IT request agent", description: "Triages the IT queue, resets MFA, and handles routine access changes.", owner: "Marcus Reyes", runs30d: 163, lastRunDaysAgo: 0, status: "Active" },
  { id: "vendor-renewal", name: "Vendor renewal agent", description: "Watches renewal dates, collects quotes, and drafts renewal summaries for owners.", owner: "Priya Shah", runs30d: 22, lastRunDaysAgo: 1, status: "Active" },
] as const;

const toolsByVendor: Record<Vendor, { system: string; tools: string[] }> = {
  okta: { system: "Okta", tools: ["create_user", "deactivate_user", "assign_admin_role", "assign_group", "remove_group", "reset_mfa", "list_users", "suspend_user"] },
  google: { system: "Google Workspace", tools: ["create_account", "suspend_account", "delete_account", "add_to_group", "reset_password", "create_calendar", "share_drive"] },
  slack: { system: "Slack", tools: ["invite", "deactivate", "create_channel", "archive_channel", "post_message", "add_to_channel"] },
  cdw: { system: "CDW", tools: ["order_laptop", "order_monitor", "order_dock", "order_headset", "track_order", "return_device"] },
  merch: { system: "Pennant & Co. Apparel", tools: ["order_polos", "order_hoodie", "order_swag_pack"] },
  print: { system: "Harbor Print Works", tools: ["order_business_cards", "order_badges", "reorder_cards"] },
  adp: { system: "ADP", tools: ["create_employee", "update_salary", "terminate_employee", "update_manager", "get_pay_stubs", "add_deduction", "list_employees"] },
  mercury: { system: "Mercury", tools: ["issue_card", "freeze_card", "set_card_limit", "list_transactions", "create_recipient", "send_payment"] },
};

export const seed = {
  org: "Fernhill Desk",
  currentUserId: "jordan-lee",
  people,
  vendors,
  inbox,
  timeOff,
  orders,
  itRequests,
  agents,
  toolsByVendor,
  ticket: {
    from: "jordan-lee",
    text: "Maya starts Monday as Marketing Coordinator. Same setup as Dana.",
  },
} as const;

export function person(id: string): Person {
  const p = people.find((x) => x.id === id);
  if (!p) throw new Error(`unknown person ${id}`);
  return p;
}


export function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/**
 * Dates the pages need, derived from today so the demo never looks stale.
 * `start` is always the next Monday strictly after today (a Monday rolls to
 * the following week; a Sunday gives tomorrow).
 */
export function seedDates(today: Date) {
  const dow = today.getDay(); // 0 Sun .. 6 Sat
  const ahead = ((8 - dow) % 7) || 7;
  const start = addDays(today, ahead);
  return { today, start, requestedAt: today };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const formatShort = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const formatLong = (d: Date) => `${WEEKDAYS[d.getDay()]}, ${formatShort(d)}`;

/** "9:12 AM" today, "Yesterday", then "Nov 2" style for older items. */
export function dayLabel(today: Date, daysAgo: number): string {
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return formatShort(addDays(today, -daysAgo));
}

export const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
export const toolCount = () => Object.values(toolsByVendor).reduce((n, v) => n + v.tools.length, 0);
export const initialsOf = (name: string) =>
  name.split(" ").map((w) => w[0]).slice(0, 2).join("");
