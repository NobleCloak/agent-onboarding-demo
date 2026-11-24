import { describe, expect, it } from "vitest";
import { modeOf, tighterOf } from "./rule-modes";

describe("rule modes", () => {
  it("maps a rule's mode, and an unknown one asks a person", () => {
    expect([modeOf("always_allow"), modeOf("ask"), modeOf("escalate"), modeOf("deny"), modeOf("not_granted"), modeOf("whatever"), modeOf(undefined)]).toEqual(["always_allow", "ask", "ask", "deny", "deny", "ask", "ask"]);
  });
  it("the tightest of several rules wins, in any order", () => {
    expect(tighterOf(undefined, "always_allow")).toBe("always_allow");
    expect(tighterOf("always_allow", "ask")).toBe("ask");
    expect(tighterOf("ask", "always_allow")).toBe("ask");
    expect(tighterOf("ask", "deny")).toBe("deny");
    expect(tighterOf("deny", "always_allow")).toBe("deny");
  });
});
