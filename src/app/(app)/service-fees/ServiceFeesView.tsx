"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ReceiptText, CheckCircle2, Circle, AlertCircle, Building2, ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { sortServiceFeeRows, type ServiceFeeSortKey, type SortDir } from "@/lib/service-fee-sort";

export type ServiceFeeRow = {
  accountId: string;
  accountName: string;
  /** Exact 2-dp string ("1234.50"), or null when no rate is agreed. */
  monthlyServiceFee: string | null;
  billed: number;
  paid: number;
  outstanding: number;
  overdue: number;
};
export type ServiceFeeTotals = { billed: number; paid: number; outstanding: number; overdue: number };

const SORT_KEYS: readonly ServiceFeeSortKey[] = ["name", "rate", "billed", "paid", "outstanding"];

type Props = {
  totals: ServiceFeeTotals;
  rows: ServiceFeeRow[];
  // Partners can't open account detail (/accounts/[id] bounces them back), so for them the row
  // name is plain text instead of a dead link that would blank on click.
  isPartner?: boolean;
  /** `write_settlements` (SUPER_ADMIN): may generate monthly fees. */
  canPrice?: boolean;
  /** A status/building filter is active, so an empty list means "no match", not "no accounts". */
  filtered?: boolean;
  sortKey?: string;
  sortDir?: string;
  /** Baku-local "YYYY-MM", chosen on the server. */
  defaultMonth: string;
};

function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function ServiceFeesView({
  totals, rows, isPartner = false, canPrice = false, filtered = false, sortKey, sortDir, defaultMonth,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [month, setMonth] = useState(defaultMonth);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ month: string; created: number; skipped: number } | null>(null);

  const key: ServiceFeeSortKey = SORT_KEYS.includes(sortKey as ServiceFeeSortKey) ? (sortKey as ServiceFeeSortKey) : "name";
  const dir: SortDir = sortDir === "desc" ? "desc" : sortDir === "asc" ? "asc" : key === "name" ? "asc" : "desc";
  const sorted = sortServiceFeeRows(rows, key, dir);

  // The header link keeps every other param (period, building, status...) and only rewrites sort/dir.
  function sortHref(k: ServiceFeeSortKey) {
    const next = new URLSearchParams(params.toString());
    // First click: names A-Z, money biggest-first. Clicking the active column flips it.
    const nextDir: SortDir = k === key ? (dir === "asc" ? "desc" : "asc") : k === "name" ? "asc" : "desc";
    next.set("sort", k);
    next.set("dir", nextDir);
    return `${pathname}?${next.toString()}`;
  }

  function sortHead(k: ServiceFeeSortKey, label: string, right?: boolean) {
    const active = k === key;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead
        className={right ? "text-right" : undefined}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <Link
          href={sortHref(k)}
          replace
          scroll={false}
          className={`inline-flex items-center gap-1 font-semibold rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {label}
          <Icon className={`size-3.5 ${active ? "" : "opacity-50"}`} aria-hidden />
        </Link>
      </TableHead>
    );
  }

  async function generate() {
    setGenerating(true);
    try {
      const res = await fetch("/api/service-fees/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month }),
      });
      if (res.status === 403) {
        toast.error("Only the owner (super admin) can generate fees. Recording a payment is still allowed.");
        return;
      }
      if (!res.ok) {
        toast.error("Failed to generate fees. Please try again.");
        return;
      }
      const r = (await res.json()) as { created: number; skipped: number };
      setResult({ month, created: r.created, skipped: r.skipped });
      router.refresh();
    } catch {
      toast.error("Failed to generate fees. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  const tiles = [
    { label: "Billed", value: totals.billed, Icon: ReceiptText, alert: false },
    { label: "Paid", value: totals.paid, Icon: CheckCircle2, alert: false },
    { label: "Outstanding", value: totals.outstanding, Icon: Circle, alert: false },
    { label: "Overdue", value: totals.overdue, Icon: AlertCircle, alert: totals.overdue > 0 },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map(({ label, value, Icon, alert }) => (
          <Card size="sm" key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className={`size-4 ${alert ? "text-destructive" : "text-muted-foreground"}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-xl font-bold tabular-nums ${alert ? "text-destructive" : ""}`}>{formatMoney(value)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {canPrice && (
        <Card size="sm">
          <CardContent className="space-y-2">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="generateMonth">Billing month</Label>
                <Input
                  id="generateMonth"
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="h-8 w-44 text-sm"
                />
              </div>
              <Button type="button" size="sm" disabled={generating || !month} onClick={generate}>
                {generating ? "Generating…" : month ? `Generate fees for ${monthLabel(month)}` : "Generate fees"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Bills every active building that has a monthly rate. Safe to run again: buildings already billed
              for the month are skipped, never billed twice.
            </p>
            {result && (
              <p role="status" className="text-sm font-medium text-foreground">
                {monthLabel(result.month)}: created {result.created}, skipped {result.skipped} (already billed)
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
          <Building2 className="size-8 mb-2 opacity-40 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">{filtered ? "No buildings match these filters" : "No accounts yet"}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {filtered ? "Try a different status, building or period" : "Service fee balances will appear once accounts are billed"}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                {sortHead("name", "Account")}
                {sortHead("rate", "Monthly rate", true)}
                {sortHead("billed", "Billed", true)}
                {sortHead("paid", "Paid", true)}
                {sortHead("outstanding", "Outstanding", true)}
                <TableHead className="text-right font-semibold text-foreground">Overdue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.accountId} className="hover:bg-muted/40 transition-colors duration-150">
                  <TableCell className="font-medium">
                    {isPartner ? (
                      r.accountName
                    ) : (
                      <Link
                        href={`/accounts/${r.accountId}`}
                        className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                      >
                        {r.accountName}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.monthlyServiceFee === null ? (
                      <span className="text-muted-foreground" title="No agreed rate: this building is never billed automatically">
                        Not set
                      </span>
                    ) : (
                      // Display only; the string itself is never posted back from here.
                      formatMoney(Number(r.monthlyServiceFee), { decimals: 2 })
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.billed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.paid)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatMoney(r.outstanding)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${r.overdue > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                    {formatMoney(r.overdue)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
