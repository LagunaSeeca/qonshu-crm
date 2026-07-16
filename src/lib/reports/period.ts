export type PeriodType = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "YEARLY" | "CUSTOM";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export function resolvePeriod(input: { type: PeriodType; from?: string; to?: string }, now: Date = new Date()): { from: Date; to: Date; label: string } {
  if (input.type === "CUSTOM") {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new RangeError("invalid dates");
    if (from > to) throw new RangeError("from after to");
    return { from, to, label: `${iso(from)} → ${iso(to)}` };
  }
  if (input.type === "MONTHLY") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from, to: now, label: `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}` };
  }
  if (input.type === "YEARLY") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    return { from, to: now, label: `${now.getUTCFullYear()}` };
  }
  const days = input.type === "BIWEEKLY" ? 14 : 7;
  const from = new Date(now.getTime() - days * 86400000);
  return { from, to: now, label: input.type === "BIWEEKLY" ? `2 weeks to ${iso(now)}` : `Week of ${iso(from)}` };
}
