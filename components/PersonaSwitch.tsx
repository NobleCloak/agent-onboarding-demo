import { UserRoundCog } from "lucide-react";
import { PERSONAS, type PersonaKey } from "../lib/approvals";

const other = (p: PersonaKey): PersonaKey => (p === "priya" ? "sam" : "priya");

/** One button that says who is deciding and switches to the other approver. */
export function PersonaSwitch({ persona, onSwitch, disabled }: { persona: PersonaKey; onSwitch: (next: PersonaKey) => void; disabled?: boolean }) {
  const me = PERSONAS[persona];
  const next = PERSONAS[other(persona)];
  return (
    <button type="button" className="persona" data-testid="persona-switch" disabled={disabled} onClick={() => onSwitch(other(persona))} aria-label={`Acting as ${me.displayName}, ${me.team}. Switch to ${next.displayName}.`}>
      <UserRoundCog aria-hidden="true" />
      <span className="who2">
        <span className="k">Acting as</span>
        <b>
          {me.displayName}, {me.team}
        </b>
      </span>
      <span className="sw">Switch to {next.displayName.split(" ")[0]}</span>
    </button>
  );
}
