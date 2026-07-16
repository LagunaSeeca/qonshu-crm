import { describe, it, expect } from "vitest";
import { resolvePeriod } from "./period";
const now = new Date("2026-07-15T12:00:00Z");
describe("resolvePeriod", () => {
  it("WEEKLY spans 7 days", () => {
    const p = resolvePeriod({ type: "WEEKLY" }, now);
    expect(Math.round((p.to.getTime() - p.from.getTime()) / 86400000)).toBe(7);
  });
  it("MONTHLY covers the calendar month with a readable label", () => {
    const p = resolvePeriod({ type: "MONTHLY" }, now);
    expect(p.from.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(p.label).toContain("2026");
  });
  it("YEARLY starts Jan 1", () => {
    expect(resolvePeriod({ type: "YEARLY" }, now).from.toISOString().slice(0, 10)).toBe("2026-01-01");
  });
  it("CUSTOM honored; reversed throws", () => {
    const p = resolvePeriod({ type: "CUSTOM", from: "2026-06-01", to: "2026-06-10" }, now);
    expect(p.from.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(() => resolvePeriod({ type: "CUSTOM", from: "2026-06-10", to: "2026-06-01" }, now)).toThrow();
  });
});
