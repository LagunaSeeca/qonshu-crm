"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Building2,
  Users,
  UserCheck,
  Wallet,
  Smartphone,
  Apple,
  Bot,
  Percent,
  Receipt,
  DollarSign,
  Zap,
  TrendingUp,
  BarChart3,
} from "lucide-react";
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
import { PERIODS, type PeriodType } from "../dashboard/DashboardView";

export type Totals = {
  accounts: number;
  appUsers: number;
  activeUsers: number;
  engagedUsers: number;
  totalDebt: number;
  installs: number;
  iosInstalls: number;
  androidInstalls: number;
  loggedInUsers: number;
  activationRate: number;
  paymentsCount: number;
  paymentsAmount: number;
  utilityCount: number;
  utilityAmount: number;
};
type MethodBreakdown = { method: string; count: number; amount: number };
type CategoryBreakdown = { category: string; count: number; amount: number };
type TrendPoint = { date: string; count: number; amount: number };
type PartnerRow = {
  accountId: string;
  accountName: string;
  appUsers: number;
  installs: number;
  engagedUsers: number;
  paymentsCount: number;
  paymentsAmount: number;
};

export type CompanyAnalyticsData = {
  totals: Totals;
  byMethod: MethodBreakdown[];
  byCategory: CategoryBreakdown[];
  trend: TrendPoint[];
  partners: PartnerRow[];
};

type AccountOption = { id: string; name: string };

type Props = {
  initialData: CompanyAnalyticsData;
  initialPeriod: PeriodType;
  // Company-filter is admin/member only — partner logins are locked server-side to their
  // own account, so both of these are omitted/empty for them and the filter never renders.
  accounts?: AccountOption[];
  showCompanyFilter?: boolean;
};

const METHOD_LABELS: Record<string, string> = { CARD: "Card", MANUAL: "Manual", CASH: "Cash" };
const CATEGORY_LABELS: Record<string, string> = {
  APARTMENT: "Apartment",
  PARKING: "Parking",
  NON_RESIDENTIAL: "Non-Residential",
  UTILITY: "Utility",
};
const METHOD_ORDER = ["CARD", "MANUAL", "CASH"];
const CATEGORY_ORDER = ["APARTMENT", "PARKING", "NON_RESIDENTIAL", "UTILITY"];

// Fixed categorical order, colorblind-safe validated (light: 600 steps; dark: violet steps
// down to 500 to stay in the dark lightness band). Slots are assigned by position, never by
// value/rank, so the same key always wears the same hue across the bars, dots, and badges.
const SERIES_COLORS = [
  { dot: "bg-sky-600", bar: "bg-sky-600" },
  { dot: "bg-violet-600 dark:bg-violet-500", bar: "bg-violet-600 dark:bg-violet-500" },
  { dot: "bg-amber-600", bar: "bg-amber-600" },
  { dot: "bg-emerald-600", bar: "bg-emerald-600" },
];

function colorFor(kind: "method" | "category", key: string) {
  const order = kind === "method" ? METHOD_ORDER : CATEGORY_ORDER;
  const idx = order.indexOf(key);
  return SERIES_COLORS[idx >= 0 ? idx : 0];
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function buildQuery(period: PeriodType, from: string, to: string, accountId: string): URLSearchParams {
  const sp = new URLSearchParams({ period });
  if (period === "CUSTOM") {
    sp.set("from", from);
    sp.set("to", to);
  }
  if (accountId !== "ALL") sp.set("accountId", accountId);
  return sp;
}

function buildTrendPath(trend: TrendPoint[], width: number, height: number) {
  const max = Math.max(...trend.map((t) => t.amount), 1);
  const pad = height * 0.1;
  const usableH = height - pad * 2;
  const stepX = trend.length > 1 ? width / (trend.length - 1) : 0;
  const points = trend.map((t, i) => ({
    x: trend.length > 1 ? i * stepX : width / 2,
    y: pad + usableH - (t.amount / max) * usableH,
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  const area = `${line} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z`;
  return { line, area };
}

function BreakdownRows({
  kind,
  rows,
}: {
  kind: "method" | "category";
  rows: { key: string; count: number; amount: number }[];
}) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
        <p className="text-sm">No data for this range</p>
      </div>
    );
  }
  const labels = kind === "method" ? METHOD_LABELS : CATEGORY_LABELS;
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const color = colorFor(kind, r.key);
        const pct = max > 0 ? Math.round((r.amount / max) * 100) : 0;
        return (
          <li key={r.key} className="flex items-center gap-3 text-sm">
            <span className="w-28 sm:w-32 shrink-0 flex items-center gap-1.5 text-foreground truncate">
              <span className={`size-2.5 rounded-full shrink-0 ${color.dot}`} aria-hidden="true" />
              {labels[r.key] ?? r.key}
            </span>
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full ${color.bar}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
              {money(r.amount)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function PartnerBars({ rows }: { rows: PartnerRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
        <p className="text-sm">No data for this range</p>
      </div>
    );
  }
  const max = Math.max(...rows.map((r) => r.paymentsAmount), 1);
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const pct = max > 0 ? Math.round((r.paymentsAmount / max) * 100) : 0;
        return (
          <li key={r.accountId} className="flex items-center gap-3 text-sm">
            <span className="w-32 sm:w-40 shrink-0 text-foreground truncate">{r.accountName}</span>
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-sky-600" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
              {money(r.paymentsAmount)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function KpiGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">{title}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{children}</div>
    </section>
  );
}

function KpiTile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

export function AnalyticsView({ initialData, initialPeriod, accounts = [], showCompanyFilter = false }: Props) {
  const [data, setData] = useState<CompanyAnalyticsData>(initialData);
  const [period, setPeriod] = useState<PeriodType>(initialPeriod);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [accountId, setAccountId] = useState("ALL");
  const [loading, setLoading] = useState(false);

  async function load(p: PeriodType, from: string, to: string, acct: string) {
    if (p === "CUSTOM" && (!from || !to)) return;
    setLoading(true);
    try {
      const sp = buildQuery(p, from, to, acct);
      const res = await fetch(`/api/analytics?${sp}`);
      if (!res.ok) {
        toast.error("Failed to load analytics.");
        return;
      }
      setData(await res.json());
    } catch {
      toast.error("Failed to load analytics.");
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

  const t = data.totals;
  const accountItems: Record<string, string> = {
    ALL: "All companies",
    ...Object.fromEntries(accounts.map((a) => [a.id, a.name])),
  };

  const trendGeo = data.trend.length > 0 ? buildTrendPath(data.trend, 400, 120) : null;
  const trendTotal = data.trend.reduce((s, p) => s + p.amount, 0);
  const trendSummary = `Payments trend: ${money(trendTotal)} total across ${data.trend.length} day${data.trend.length === 1 ? "" : "s"}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">Across all partner companies</p>
      </div>

      {/* Period selector */}
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
          <Label htmlFor="analyticsFrom" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="analyticsFrom"
            type="date"
            value={customFrom}
            onChange={(e) => handleCustomDate("from", e.target.value)}
            className="h-7 w-36 text-xs"
          />
          <Label htmlFor="analyticsTo" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="analyticsTo"
            type="date"
            value={customTo}
            onChange={(e) => handleCustomDate("to", e.target.value)}
            className="h-7 w-36 text-xs"
          />
        </div>

        {showCompanyFilter && (
          <Select items={accountItems} value={accountId} onValueChange={(v) => { if (v) handleAccount(v); }}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All companies</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* KPI tiles */}
      <KpiGroup title="Partners">
        <KpiTile label="Partner Accounts" value={t.accounts.toLocaleString()} icon={Building2} />
        <KpiTile
          label="App Users (active/total)"
          value={`${t.activeUsers.toLocaleString()}/${t.appUsers.toLocaleString()}`}
          icon={Users}
        />
        <KpiTile label="Users Engaged" value={t.engagedUsers.toLocaleString()} icon={UserCheck} />
        <KpiTile label="Total Debt" value={money(t.totalDebt)} icon={Wallet} />
      </KpiGroup>

      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Smartphone className="size-4 text-muted-foreground" />
            Installs &amp; Activation
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Total Installs</span>
                <Smartphone className="size-4 text-muted-foreground" />
              </div>
              <div className="text-xl font-bold tabular-nums">{t.installs.toLocaleString()}</div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">iOS</span>
                <Apple className="size-4 text-muted-foreground" />
              </div>
              <div className="text-xl font-bold tabular-nums">{t.iosInstalls.toLocaleString()}</div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Android</span>
                <Bot className="size-4 text-muted-foreground" />
              </div>
              <div className="text-xl font-bold tabular-nums">{t.androidInstalls.toLocaleString()}</div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Logged-in Users</span>
                <UserCheck className="size-4 text-muted-foreground" />
              </div>
              <div className="text-xl font-bold tabular-nums">{t.loggedInUsers.toLocaleString()}</div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Activation Rate</span>
                <Percent className="size-4 text-muted-foreground" />
              </div>
              <div className="text-xl font-bold tabular-nums">{t.activationRate}%</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <KpiGroup title="Payments">
        <KpiTile label="Payments" value={t.paymentsCount.toLocaleString()} icon={Receipt} />
        <KpiTile label="Payments Amount" value={money(t.paymentsAmount)} icon={DollarSign} />
        <KpiTile label="Utility Amount" value={money(t.utilityAmount)} icon={Zap} />
      </KpiGroup>

      {/* Trend chart */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <TrendingUp className="size-4 text-muted-foreground" />
            Payments Trend
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {data.trend.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
              <TrendingUp className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No data for this range</p>
            </div>
          ) : (
            <div className="text-sky-600 dark:text-sky-400">
              <svg
                viewBox="0 0 400 120"
                preserveAspectRatio="none"
                className="w-full h-32"
                role="img"
                aria-label={trendSummary}
              >
                <title>{trendSummary}</title>
                {trendGeo && (
                  <>
                    <path d={trendGeo.area} fill="currentColor" fillOpacity={0.12} stroke="none" />
                    <path
                      d={trendGeo.line}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </>
                )}
              </svg>
              <p className="text-xs text-muted-foreground mt-2 tabular-nums">{trendSummary}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">By Payment Method</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <BreakdownRows
              kind="method"
              rows={data.byMethod.map((r) => ({ key: r.method, count: r.count, amount: r.amount }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">By Category</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <BreakdownRows
              kind="category"
              rows={data.byCategory.map((r) => ({ key: r.category, count: r.count, amount: r.amount }))}
            />
          </CardContent>
        </Card>
      </div>

      {/* Per-partner comparison */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <BarChart3 className="size-4 text-muted-foreground" />
            Payments by Partner
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <PartnerBars rows={data.partners} />
        </CardContent>
      </Card>

      {/* Per-partner table */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold">Partners</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {data.partners.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Building2 className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No partner accounts yet</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="font-semibold text-foreground">Partner</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">App Users</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Installs</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Engaged Users</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Payments</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Payments Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.partners.map((p) => (
                    <TableRow key={p.accountId}>
                      <TableCell className="font-medium">
                        <Link href={`/accounts/${p.accountId}`} className="hover:underline text-accent">
                          {p.accountName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.appUsers.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.installs.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.engagedUsers.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.paymentsCount.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {money(p.paymentsAmount)}
                      </TableCell>
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
