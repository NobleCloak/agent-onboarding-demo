import { describe, expect, it } from "vitest";
import { formatShort, seed, seedDates } from "./seed";

// Local-time constructors keep these tests timezone independent.
const monday = new Date(2026, 10, 2, 9, 30); // Mon Nov 2 2026
const sunday = new Date(2026, 10, 8, 22, 0); // Sun Nov 8 2026
const wednesday = new Date(2026, 10, 4, 12, 0);

describe("seedDates", () => {
  it("returns the following Monday when today is a Monday", () => {
    const { start } = seedDates(monday);
    expect(start.getDay()).toBe(1);
    expect(start.getTime()).toBeGreaterThan(monday.getTime());
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 10, 9]);
  });

  it("returns the next day when today is a Sunday", () => {
    const { start } = seedDates(sunday);
    expect(start.getDay()).toBe(1);
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 10, 9]);
  });

  it("is always a future Monday, for every weekday", () => {
    for (let i = 0; i < 14; i++) {
      const today = new Date(2026, 10, 1 + i, 15, 0);
      const { start } = seedDates(today);
      expect(start.getDay()).toBe(1);
      expect(start.getTime()).toBeGreaterThan(today.getTime());
      expect(start.getTime() - today.getTime()).toBeLessThanOrEqual(8 * 86_400_000);
    }
  });

  it("formats the start date like the mockup", () => {
    expect(formatShort(seedDates(wednesday).start)).toBe("Nov 9");
  });
});

describe("seed", () => {
  it("contains the demo cast and the ticket text", () => {
    const names = seed.people.map((p) => p.name);
    for (const n of ["Jordan Lee", "Maya Torres", "Dana Whitfield", "Priya Shah", "Sam Okoye"]) {
      expect(names).toContain(n);
    }
    expect(seed.ticket.text).toBe(
      "Maya starts Monday as Marketing Coordinator. Same setup as Dana.",
    );
    expect(seed.people.find((p) => p.name === "Maya Torres")?.managerId).toBe(
      seed.people.find((p) => p.name === "Dana Whitfield")?.id,
    );
  });
});

describe("tools", () => {
  it("totals 46 so the Permissions page can say All 46", async () => {
    const { toolCount } = await import("./seed");
    expect(toolCount()).toBe(46);
  });
});
