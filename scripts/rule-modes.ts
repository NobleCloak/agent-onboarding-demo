// How published rules decide: the mode a rule names, and which of several rules wins. One definition, used by the local
// mock shim (scripts/noblecloak-local.ts) and by preflight, so the check cannot drift from what the shim does.
export type Mode = "always_allow" | "ask" | "deny";

/** The mode a published rule's `config.mode` means. An unknown value asks a person. */
const TIGHTNESS: Record<string, Mode> = { not_granted: "deny", deny: "deny", escalate: "ask", ask: "ask", always_allow: "always_allow" };
/** Tightest first. */
const ORDER: Mode[] = ["deny", "ask", "always_allow"];

export const modeOf = (raw: unknown): Mode => TIGHTNESS[String(raw)] ?? "ask";

/** When several rules cover a tool, the tightest decides. */
export const tighterOf = (current: Mode | undefined, next: Mode): Mode => (current === undefined || ORDER.indexOf(next) < ORDER.indexOf(current) ? next : current);
