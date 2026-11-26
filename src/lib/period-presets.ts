// Calendar-month period presets in BAKU LOCAL TIME (UTC+4).
//
// CONVENTION NOTE (read this before reusing): the business is in Baku and money cut-offs must follow
// Baku local months, so a card payment at 02:00 Baku time on the 1st counts in the NEW month. This
// module is Baku-time. `src/lib/reports/period.ts` and `src/lib/analytics/range.ts` are still UTC;
// that inconsistency is known and accepted as a follow-up. Settlements / service-fees use THIS file;
// reports / analytics keep using the UTC ones until migrated. Same parse/validation style and the
// same error (`RangeError`) as those two files.

// Baku is UTC+4 year-round: Azerbaijan abolished DST in 2016, so a fixed offset is safe and no
// timezone library is needed. If the business moves to a zone with DST (or a different offset),
// THIS constant is the only place that must change, and DST would then need a real tz library.
export const BAKU_UTC_OFFSET_HOURS = 4;
const OFFSET_MS = BAKU_UTC_OFFSET_HOURS * 3600000;

export type PeriodPreset = "this-month" | "last-month" | "this-year" | "custom";
export const PERIOD_PRESETS: readonly PeriodPreset[] = ["this-month", "last-month", "this-year", "custom"];

export function isPeriodPreset(v: unknown): v is PeriodPreset {
  return typeof v === "string" && (PERIOD_PRESETS as readonly string[]).includes(v);
}

// Absolute instant of Baku-local midnight at the start of (year, month0, day). Date.UTC normalises
// month overflow/underflow, so month0 = -1 is December of the previous year.
const bakuStart = (year: number, month0: number, day = 1) => new Date(Date.UTC(year, month0, day) - OFFSET_MS);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

// "YYYY-MM-DD" (a Baku calendar date) -> its Y/M/D, or throws like the existing parsers.
function parseDate(s: string | undefined): { y: number; m: number; d: number } {
  const match = typeof s === "string" ? DATE_RE.exec(s) : null;
  if (!match) throw new RangeError("invalid dates");
  const y = Number(match[1]), m = Number(match[2]) - 1, d = Number(match[3]);
  const check = new Date(Date.UTC(y, m, d));
  // Round-trip rejects 2026-02-31 etc.; the year window rejects absurd ranges.
  if (isNaN(check.getTime()) || check.getUTCMonth() !== m || check.getUTCDate() !== d || y < MIN_YEAR || y > MAX_YEAR) {
    throw new RangeError("invalid dates");
  }
  return { y, m, d };
}

export function resolvePeriodPreset(
  input: { preset?: PeriodPreset; from?: string; to?: string },
  now: Date = new Date(),
): { from: Date; to: Date } {
  if (input.preset === "custom" || input.from || input.to) {
    const f = parseDate(input.from);
    const t = parseDate(input.to);
    const from = bakuStart(f.y, f.m, f.d);
    // Inclusive end of the Baku day, like the existing 23:59:59.999 convention.
    const to = new Date(bakuStart(t.y, t.m, t.d + 1).getTime() - 1);
    if (from > to) throw new RangeError("from after to");
    return { from, to };
  }
  // Shift into Baku wall-clock so getUTC* reads Baku's year/month.
  const local = new Date(now.getTime() + OFFSET_MS);
  const y = local.getUTCFullYear(), m = local.getUTCMonth();
  // The upper bound is the END OF THE CURRENT BAKU PERIOD, NOT `now`.
  //
  // `to: now` looked harmless and was a real bug. Rows are filtered `periodMonth <= to`, and
  // ServiceFee.periodMonth is the UTC first-of-month. A Baku month begins at 20:00Z the previous
  // day, so between Baku 00:00 and 04:00 on the 1st, `now` sits BELOW that month's periodMonth and
  // the month's own fees matched nothing: /service-fees showed every building billed 0, all four
  // totals ₼0, and under a status filter an empty table — the billing page reporting no
  // outstanding money at all. On 1 January that applied to "this-year" too, hiding the whole year.
  //
  // Clamping to the period end also makes the window stable: a figure does not change just
  // because the page was re-rendered a minute later, and a fee dated later this month (a due date
  // ahead of today) is inside "this month" where a reader expects it.
  switch (input.preset ?? "this-month") {
    case "last-month":
      return { from: bakuStart(y, m - 1), to: new Date(bakuStart(y, m).getTime() - 1) };
    case "this-year":
      return { from: bakuStart(y, 0), to: new Date(bakuStart(y + 1, 0).getTime() - 1) };
    case "this-month":
    default:
      return { from: bakuStart(y, m), to: new Date(bakuStart(y, m + 1).getTime() - 1) };
  }
}
