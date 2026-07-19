"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ReceiptText, CheckCircle2, Circle, Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type ServiceFeeRow = { accountId: string; accountName: string; billed: number; paid: number; outstanding: number };
export type ServiceFeeSummary = {
  totals: { billed: number; paid: number; outstanding: number };
  rows: ServiceFeeRow[];
};

type Props = { initialData: ServiceFeeSummary };

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function ServiceFeesView({ initialData }: Props) {
  const [data, setData] = useState<ServiceFeeSummary>(initialData);
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  async function toggleUnpaidOnly() {
    const next = !unpaidOnly;
    setUnpaidOnly(next);
    setLoading(true);
    try {
      const sp = next ? "?status=UNPAID" : "";
      const res = await fetch(`/api/service-fees${sp}`);
      if (!res.ok) {
        toast.error("Failed to load service fees.");
        return;
      }
      setData(await res.json());
    } catch {
      toast.error("Failed to load service fees.");
    } finally {
      setLoading(false);
    }
  }

  const { totals, rows } = data;

  return (
    <div className="space-y-6">
      {/* Totals — dimmed while a refetch is in flight so the previous numbers stay visible
          instead of flashing blank. */}
      <div className={cn("grid grid-cols-1 sm:grid-cols-3 gap-4", loading && "opacity-60 pointer-events-none transition-opacity")} aria-busy={loading}>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Billed</CardTitle>
            <ReceiptText className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(totals.billed)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Paid</CardTitle>
            <CheckCircle2 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(totals.paid)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Outstanding</CardTitle>
            <Circle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-foreground">{money(totals.outstanding)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          variant={unpaidOnly ? "default" : "outline"}
          aria-pressed={unpaidOnly}
          disabled={loading}
          onClick={toggleUnpaidOnly}
        >
          Unpaid only
        </Button>
      </div>

      {/* Per-account table */}
      <div className={cn(loading && "opacity-60 pointer-events-none transition-opacity")} aria-busy={loading}>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
          <Building2 className="size-8 mb-2 opacity-40 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">No accounts yet</p>
          <p className="text-xs text-muted-foreground mt-1">Service fee balances will appear once accounts are billed</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="font-semibold text-foreground">Account</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Billed</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Paid</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.accountId} className="hover:bg-muted/40 transition-colors duration-150">
                  <TableCell className="font-medium">
                    <Link
                      href={`/accounts/${r.accountId}`}
                      className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                    >
                      {r.accountName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.billed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.paid)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{money(r.outstanding)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      </div>
    </div>
  );
}
