"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Download, FileBarChart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PERIODS, type PeriodType, type DashboardStats } from "../dashboard/DashboardView";

export type PartnerRow = {
  accountId: string;
  accountName: string;
  paymentsCount: number;
  paymentsAmount: number;
  collected: number;
  transferred: number;
  owed: number;
};

export type Report = {
  label: string;
  scope: string;
  accountName?: string;
  kpis: DashboardStats;
  partnerRows: PartnerRow[];
};

type Account = { id: string; name: string };

type Props = { accounts: Account[]; initialReport: Report };

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function SummaryRow({
  label,
  value,
  warning,
  emphasize,
}: {
  label: string;
  value: string;
  warning?: boolean;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tabular-nums font-medium",
          warning && "text-amber-600 dark:text-amber-400",
          emphasize && "text-accent font-bold"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function buildQuery(period: PeriodType, from: string, to: string, accountId: string): URLSearchParams {
  const sp = new URLSearchParams({ period });
  if (period === "CUSTOM") {
    sp.set("from", from);
    sp.set("to", to);
  }
  if (accountId !== "ALL") sp.set("accountId", accountId);
  return sp;
}

export function ReportView({ accounts, initialReport }: Props) {
  const [report, setReport] = useState<Report>(initialReport);
  const [period, setPeriod] = useState<PeriodType>("MONTHLY");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [accountId, setAccountId] = useState("ALL");
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function load(p: PeriodType, from: string, to: string, acct: string) {
    if (p === "CUSTOM" && (!from || !to)) return;
    setLoading(true);
    try {
      const sp = buildQuery(p, from, to, acct);
      const res = await fetch(`/api/reports?${sp}`);
      if (!res.ok) {
        toast.error("Failed to load report.");
        return;
      }
      setReport(await res.json());
    } catch {
      toast.error("Failed to load report.");
    } finally {
      setLoading(false);
    }
  }

  function handlePeriod(p: Exclude<PeriodType, "CUSTOM">) {
    setPeriod(p);
    setCustomFrom("");
    setCustomTo("");
    void load(p, "", "", accountId);
  }

  function handleCustomDate(which: "from" | "to", value: string) {
    const nextFrom = which === "from" ? value : customFrom;
    const nextTo = which === "to" ? value : customTo;
    if (which === "from") setCustomFrom(value);
    else setCustomTo(value);
    setPeriod("CUSTOM");
    if (nextFrom && nextTo) void load("CUSTOM", nextFrom, nextTo, accountId);
  }

  function handleAccount(val: string) {
    setAccountId(val);
    void load(period, customFrom, customTo, val);
  }

  async function handleDownloadCsv() {
    setDownloading(true);
    try {
      const sp = buildQuery(period, customFrom, customTo, accountId);
      const res = await fetch(`/api/reports/csv?${sp}`);
      if (!res.ok) {
        toast.error("Failed to download CSV.");
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition");
      const match = cd?.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? "report.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Failed to download CSV.");
    } finally {
      setDownloading(false);
    }
  }

  const k = report.kpis;
  const rows = report.partnerRows;
  const accountItems: Record<string, string> = {
    ALL: "All partners",
    ...Object.fromEntries(accounts.map((a) => [a.id, a.name])),
  };

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Period" className="flex items-center gap-1">
          {PERIODS.map((p) => {
            const active = period === p.key;
            return (
              <Button
                key={p.key}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                disabled={loading}
                onClick={() => handlePeriod(p.key)}
              >
                {p.label}
              </Button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <Label htmlFor="repFrom" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="repFrom"
            type="date"
            value={customFrom}
            onChange={(e) => handleCustomDate("from", e.target.value)}
            className="h-7 w-36 text-xs"
          />
          <Label htmlFor="repTo" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="repTo"
            type="date"
            value={customTo}
            onChange={(e) => handleCustomDate("to", e.target.value)}
            className="h-7 w-36 text-xs"
          />
        </div>

        <Select items={accountItems} value={accountId} onValueChange={(v) => { if (v) handleAccount(v); }}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All partners</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={handleDownloadCsv}
          disabled={downloading}
        >
          <Download className="size-4" />
          {downloading ? "Downloading…" : "Download CSV"}
        </Button>
      </div>

      {/* Period label */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{report.label}</h2>
        {report.accountName && (
          <p className="text-sm text-muted-foreground mt-0.5">Partner: {report.accountName}</p>
        )}
      </div>

      {/* KPI summary */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold">Summary</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sales</h3>
              <SummaryRow label="Open leads" value={k.sales.openLeads.toLocaleString()} />
              <SummaryRow label="Won this period" value={k.sales.wonInPeriod.toLocaleString()} />
            </div>
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Activity</h3>
              <SummaryRow label="Meetings done" value={k.activity.meetingsDone.toLocaleString()} />
              <SummaryRow label="Open tasks" value={k.activity.openTasks.toLocaleString()} />
              <SummaryRow label="Overdue" value={k.activity.overdueTasks.toLocaleString()} warning />
            </div>
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Partners</h3>
              <SummaryRow label="Partner accounts" value={k.partners.accounts.toLocaleString()} />
              <SummaryRow
                label="App users (active/total)"
                value={`${k.partners.activeAppUsers.toLocaleString()}/${k.partners.appUsers.toLocaleString()}`}
              />
              <SummaryRow label="Users engaged" value={k.partners.engagedUsers.toLocaleString()} />
              <SummaryRow label="Payments amount" value={money(k.partners.paymentsAmount)} />
            </div>
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Finance</h3>
              <SummaryRow label="Collected" value={money(k.finance.collected)} />
              <SummaryRow label="Transferred" value={money(k.finance.transferred)} />
              <SummaryRow label="Owed" value={money(k.finance.owed)} emphasize />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Partner table */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold">Partners</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <FileBarChart className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No partner activity for this period</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="font-semibold text-foreground">Partner</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Payments</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Payments Amount</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Collected</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Transferred</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Owed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.accountId}>
                      <TableCell className="font-medium">{r.accountName}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.paymentsCount.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.paymentsAmount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.collected)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.transferred)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{money(r.owed)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
