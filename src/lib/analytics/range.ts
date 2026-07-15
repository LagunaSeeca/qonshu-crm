export type RangePreset = "DAILY" | "7D" | "30D" | "90D" | "1Y";
const DAYS: Record<Exclude<RangePreset, "DAILY">, number> = { "7D": 7, "30D": 30, "90D": 90, "1Y": 365 };

export function resolveRange(input: { preset?: RangePreset; from?: string; to?: string }, now: Date = new Date()): { from: Date; to: Date } {
  if (input.from || input.to) {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new RangeError("invalid dates");
    if (from > to) throw new RangeError("from after to");
    return { from, to };
  }
  const to = now;
  if (input.preset === "DAILY") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    return { from, to };
  }
  const days = DAYS[(input.preset ?? "30D") as Exclude<RangePreset, "DAILY">] ?? 30;
  return { from: new Date(to.getTime() - days * 86400000), to };
}
