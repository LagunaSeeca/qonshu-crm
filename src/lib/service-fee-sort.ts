// PURE sort for the billing roll-up table (no DB, safe in a client component). Sorting is done in the
// UI rather than the query: the rows are already one per visible building and are not paginated.

export type ServiceFeeSortKey = "name" | "rate" | "billed" | "paid" | "outstanding";
export type SortDir = "asc" | "desc";

export type SortableFeeRow = {
  accountId: string; accountName: string; monthlyServiceFee: string | null;
  billed: number; paid: number; outstanding: number;
};

// Returns a NEW array; never mutates. Rows with no rate sort LAST in both directions (an empty rate
// is "unknown", not "smallest"). Ties break on name (case-insensitive) then accountId, so the order
// is total and stable across renders.
export function sortServiceFeeRows<T extends SortableFeeRow>(rows: readonly T[], key: ServiceFeeSortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: T, b: T) =>
    a.accountName.localeCompare(b.accountName, undefined, { sensitivity: "base" }) || a.accountId.localeCompare(b.accountId);
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * byName(a, b);
    let c: number;
    if (key === "rate") {
      const x = a.monthlyServiceFee === null ? null : Number(a.monthlyServiceFee);
      const y = b.monthlyServiceFee === null ? null : Number(b.monthlyServiceFee);
      if (x === null && y === null) return byName(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      c = x - y;
    } else {
      c = a[key] - b[key];
    }
    return c !== 0 ? sign * c : byName(a, b);
  });
}
