import { describe, it, expect } from "vitest";
import { resolveRange } from "./range";

const now = new Date("2026-06-30T12:00:00Z");
describe("resolveRange", () => {
  it("7D spans 7 days back to now", () => {
    const { from, to } = resolveRange({ preset: "7D" }, now);
    expect(to.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(Math.round((to.getTime() - from.getTime()) / 86400000)).toBe(7);
  });
  it("custom from/to honored", () => {
    const { from, to } = resolveRange({ from: "2026-06-01", to: "2026-06-10" }, now);
    expect(from.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(to.toISOString().slice(0, 10)).toBe("2026-06-10");
  });
  it("from>to throws", () => {
    expect(() => resolveRange({ from: "2026-06-10", to: "2026-06-01" }, now)).toThrow();
  });
});
