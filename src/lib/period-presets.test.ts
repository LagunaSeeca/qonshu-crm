import { describe, it, expect } from "vitest";
import { resolvePeriodPreset, isPeriodPreset } from "./period-presets";

// Baku = UTC+4: Baku midnight on the 1st is 20:00 UTC on the last day of the previous month.
const NOW = new Date("2026-11-26T10:00:00.000Z");

describe("resolvePeriodPreset", () => {
  // `to` is the END OF THE BAKU MONTH, not `now`. It used to be `now`, which broke /service-fees:
  // ServiceFee.periodMonth is UTC first-of-month, and between 00:00 and 04:00 Baku on the 1st
  // `now` sits BELOW it, so the month's own fees matched nothing and the billing page showed ₼0
  // outstanding. Clamping to the period end also keeps the window stable between re-renders.
  it("this-month: the whole Baku month, not up to `now`", () => {
    const r = resolvePeriodPreset({ preset: "this-month" }, NOW);
    expect(r.from.toISOString()).toBe("2026-10-31T20:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-30T19:59:59.999Z");
  });
  it("this-month at 01:30 Baku on the 1st still covers that whole month", () => {
    // 2027-01-01T01:30 Baku = 2026-12-31T21:30Z. The old `to: now` produced an upper bound below
    // January's periodMonth (2027-01-01T00:00Z), emptying the table.
    const r = resolvePeriodPreset({ preset: "this-month" }, new Date("2026-12-31T21:30:00.000Z"));
    expect(r.from.toISOString()).toBe("2026-12-31T20:00:00.000Z");
    expect(r.to.toISOString()).toBe("2027-01-31T19:59:59.999Z");
    expect(r.to.getTime()).toBeGreaterThan(Date.UTC(2027, 0, 1)); // above January's periodMonth
  });
  it("defaults to this-month", () => {
    expect(resolvePeriodPreset({}, NOW).from.toISOString()).toBe("2026-10-31T20:00:00.000Z");
  });
  it("last-month: full previous Baku month, ends 1ms before this month", () => {
    const r = resolvePeriodPreset({ preset: "last-month" }, NOW);
    expect(r.from.toISOString()).toBe("2026-09-30T20:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-31T19:59:59.999Z");
  });
  it("this-year: the whole Baku year, not up to `now`", () => {
    const r = resolvePeriodPreset({ preset: "this-year" }, NOW);
    expect(r.from.toISOString()).toBe("2025-12-31T20:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-12-31T19:59:59.999Z");
  });
  it("this-year on 1 January covers the new year, not an empty window", () => {
    // The `to: now` bug was worst here: on 1 Jan before 04:00 Baku the whole year read ₼0.
    const r = resolvePeriodPreset({ preset: "this-year" }, new Date("2026-12-31T21:30:00.000Z"));
    expect(r.from.toISOString()).toBe("2026-12-31T20:00:00.000Z");
    expect(r.to.toISOString()).toBe("2027-12-31T19:59:59.999Z");
  });
  it("02:00 Baku on the 1st (= 22:00 UTC the day before) lands in the NEW month, not the previous", () => {
    const payment = new Date("2026-10-31T22:00:00.000Z"); // 2026-11-01 02:00 Baku
    const now = new Date("2026-11-15T10:00:00.000Z");
    const thisMonth = resolvePeriodPreset({ preset: "this-month" }, now);
    const lastMonth = resolvePeriodPreset({ preset: "last-month" }, now);
    expect(payment >= thisMonth.from && payment <= thisMonth.to).toBe(true);
    expect(payment >= lastMonth.from && payment <= lastMonth.to).toBe(false);
  });
  it("the instant just before Baku midnight stays in the previous month", () => {
    const now = new Date("2026-11-15T10:00:00.000Z");
    const t = new Date("2026-10-31T19:59:59.999Z"); // 2026-10-31 23:59:59.999 Baku
    const last = resolvePeriodPreset({ preset: "last-month" }, now);
    expect(t >= last.from && t <= last.to).toBe(true);
  });
  it("uses the Baku month when UTC is still the previous month", () => {
    // 2026-11-30 21:00 UTC is already 2026-12-01 01:00 in Baku.
    const r = resolvePeriodPreset({ preset: "this-month" }, new Date("2026-11-30T21:00:00.000Z"));
    expect(r.from.toISOString()).toBe("2026-11-30T20:00:00.000Z");
  });
  it("January last-month rolls back to previous December", () => {
    const r = resolvePeriodPreset({ preset: "last-month" }, new Date("2027-01-10T10:00:00.000Z"));
    expect(r.from.toISOString()).toBe("2026-11-30T20:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-12-31T19:59:59.999Z");
  });
  it("custom: inclusive Baku days", () => {
    const r = resolvePeriodPreset({ preset: "custom", from: "2026-03-01", to: "2026-03-31" }, NOW);
    expect(r.from.toISOString()).toBe("2026-02-28T20:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-03-31T19:59:59.999Z");
  });
  it("explicit from/to wins over a preset", () => {
    const r = resolvePeriodPreset({ preset: "this-month", from: "2026-01-05", to: "2026-01-05" }, NOW);
    expect(r.to.getTime() - r.from.getTime()).toBe(86400000 - 1);
  });
  it("rejects from > to", () => {
    expect(() => resolvePeriodPreset({ preset: "custom", from: "2026-05-02", to: "2026-05-01" }, NOW)).toThrow(RangeError);
  });
  it("rejects unparseable, missing, impossible and absurd dates", () => {
    const bad: [string, string | undefined][] = [
      ["nope", "2026-01-01"],
      ["2026-01-01", undefined],
      ["2026-02-31", "2026-03-01"],
      ["0001-01-01", "2026-01-01"],
      ["2026-01-01", "9999-12-31"],
    ];
    for (const [from, to] of bad) {
      expect(() => resolvePeriodPreset({ preset: "custom", from, to }, NOW)).toThrow(RangeError);
    }
  });
  it("isPeriodPreset", () => {
    expect(isPeriodPreset("last-month")).toBe(true);
    expect(isPeriodPreset("7D")).toBe(false);
    expect(isPeriodPreset(undefined)).toBe(false);
  });
});
