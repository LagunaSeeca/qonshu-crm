import { describe, it, expect } from "vitest";
import { trialDaysLeft, toTrialDate, todayTrialDate, DEFAULT_TRIAL_DAYS } from "./trial";

// PURE, NO DATABASE. The stored side is built with Date.UTC because that is exactly what Prisma
// returns for a `@db.Date` column (UTC midnight of the civil day). "Today" is built with the LOCAL
// constructor at MIDDAY, which is what a wall-clock `new Date()` looks like — midday so the test
// means the same civil day in every zone the suite might run in (±14h offsets included).
const stored = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const today = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

describe("trialDaysLeft", () => {
  it("is 0 on the last day of the trial", () => {
    expect(trialDaysLeft(stored(2026, 3, 10), today(2026, 3, 10))).toBe(0);
  });

  it("is 1 the day before it ends", () => {
    expect(trialDaysLeft(stored(2026, 3, 10), today(2026, 3, 9))).toBe(1);
  });

  it("is negative once expired", () => {
    expect(trialDaysLeft(stored(2026, 3, 10), today(2026, 3, 11))).toBe(-1);
    expect(trialDaysLeft(stored(2026, 3, 10), today(2026, 3, 20))).toBe(-10);
  });

  it("counts across a month boundary", () => {
    expect(trialDaysLeft(stored(2026, 4, 1), today(2026, 3, 30))).toBe(2);
    // February 2026 has 28 days: Feb 27 -> Mar 2 is 3 days, not 4.
    expect(trialDaysLeft(stored(2026, 3, 2), today(2026, 2, 27))).toBe(3);
  });

  it("counts across a year boundary and far into the future", () => {
    expect(trialDaysLeft(stored(2027, 1, 1), today(2026, 12, 31))).toBe(1);
    // A 90-day trial started today ends 90 days out and reads back as exactly 90.
    const start = today(2026, 1, 1);
    const end = new Date(todayTrialDate(start).getTime() + DEFAULT_TRIAL_DAYS * 86_400_000);
    expect(trialDaysLeft(end, start)).toBe(DEFAULT_TRIAL_DAYS);
  });

  // DST: the arithmetic is done on UTC-midnight values, so a 23-hour or 25-hour local day cannot
  // round the difference up or down. Europe/Baku has no DST today, but the suite must not depend
  // on the runner's zone, so the spring-forward window is asserted explicitly.
  it("is unaffected by a DST transition inside the window", () => {
    // EU clocks go forward on 2026-03-29, US clocks on 2026-03-08.
    expect(trialDaysLeft(stored(2026, 3, 31), today(2026, 3, 28))).toBe(3);
    expect(trialDaysLeft(stored(2026, 3, 10), today(2026, 3, 7))).toBe(3);
    // And backward, on 2026-10-25 / 2026-11-01.
    expect(trialDaysLeft(stored(2026, 10, 27), today(2026, 10, 24))).toBe(3);
    expect(trialDaysLeft(stored(2026, 11, 3), today(2026, 10, 31))).toBe(3);
  });

  it("reads the stored value off its UTC parts, not the local ones", () => {
    // A `@db.Date` round-trip is idempotent through toTrialDate whatever the runner's zone.
    const d = stored(2026, 3, 10);
    expect(toTrialDate(d).toISOString()).toBe("2026-03-10T00:00:00.000Z");
  });

  it("reads 'today' off its LOCAL parts, so a late-evening or early-morning now is not off by one", () => {
    // 23:30 and 00:30 local on the same civil day must both give the same answer.
    const late = new Date(2026, 2, 9, 23, 30, 0);
    const early = new Date(2026, 2, 9, 0, 30, 0);
    expect(trialDaysLeft(stored(2026, 3, 10), late)).toBe(1);
    expect(trialDaysLeft(stored(2026, 3, 10), early)).toBe(1);
  });
});
