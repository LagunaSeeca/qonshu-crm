"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Users,
  UsersRound,
  Wallet,
  Receipt,
  DollarSign,
  Zap,
  RefreshCw,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
  Smartphone,
  Apple,
  Bot,
  UserCheck,
  Percent,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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

type RangePreset = "DAILY" | "7D" | "30D" | "90D" | "1Y";
type RangeSel = { preset: RangePreset; from: string; to: string };

type Kpis = {
  activeUsers: number;
  totalUsers: number;
  totalDebt: number;
  paymentsCount: number;
  paymentsAmount: number;
  utilityCount: number;
  utilityAmount: number;
};
type MethodBreakdown = { method: string; count: number; amount: number };
type CategoryBreakdown = { category: string; count: number; amount: number };
type TrendPoint = { date: string; count: number; amount: number };
type TopUser = { name: string; paid: number; debt: number };
type Installs = { total: number; ios: number; android: number; activated: number; activationRate: number };

type AnalyticsData = {
  kpis: Kpis;
  byMethod: MethodBreakdown[];
  byCategory: CategoryBreakdown[];
  trend: TrendPoint[];
  topUsers: TopUser[];
  installs: Installs;
};

type PaymentRow = {
  id: string;
  occurredAt: string;
  amount: number;
  method: string;
  category: string;
  userName: string;
};

type Props = {
  accountId: string;
  initialData?: AnalyticsData;
};

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "DAILY", label: "Daily" },
  { key: "7D", label: "7D" },
  { key: "30D", label: "30D" },
  { key: "90D", label: "90D" },
  { key: "1Y", label: "1Y" },
];

const TAKE = 25;

const METHOD_LABELS: Record<string, string> = { CARD: "Card", MANUAL: "Manual", CASH: "Cash" };
const CATEGORY_LABELS: Record<string, string> = {
  APARTMENT: "Apartment",
  PARKING: "Parking",
  NON_RESIDENTIAL: "Non-Residential",
  UTILITY: "Utility",
};
const METHOD_ORDER = ["CARD", "MANUAL", "CASH"];
const CATEGORY_ORDER = ["APARTMENT", "PARKING", "NON_RESIDENTIAL", "UTILITY"];
const METHOD_FILTER_ITEMS: Record<string, string> = { ALL: "All methods", ...METHOD_LABELS };
const CATEGORY_FILTER_ITEMS: Record<string, string> = { ALL: "All categories", ...CATEGORY_LABELS };

// Fixed categorical order, colorblind-safe validated (light: 600 steps; dark: violet steps
// down to 500 to stay in the dark lightness band). Slots are assigned by position, never by
// value/rank, so the same key always wears the same hue across the bars, dots, and badges.
const SERIES_COLORS = [
  {
    dot: "bg-sky-600",
    bar: "bg-sky-600",
    badge: "text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950",
  },
  {
    dot: "bg-violet-600 dark:bg-violet-500",
    bar: "bg-violet-600 dark:bg-violet-500",
    badge: "text-violet-700 border-violet-300 bg-violet-50 dark:text-violet-400 dark:border-violet-700 dark:bg-violet-950",
  },
  {
    dot: "bg-amber-600",
    bar: "bg-amber-600",
    badge: "text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950",
  },
  {
    dot: "bg-emerald-600",
    bar: "bg-emerald-600",
    badge: "text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-700 dark:bg-emerald-950",
  },
];

function colorFor(kind: "method" | "category", key: string) {
  const order = kind === "method" ? METHOD_ORDER : CATEGORY_ORDER;
  const idx = order.indexOf(key);
  return SERIES_COLORS[idx >= 0 ? idx : 0];
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function buildRangeQuery(range: RangeSel): URLSearchParams {
  const sp = new URLSearchParams();
  if (range.from && range.to) {
    sp.set("from", range.from);
    sp.set("to", range.to);
  } else {
    sp.set("preset", range.preset);
  }
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

export function Analytics({ accountId, initialData }: Props) {
  const router = useRouter();

  const [data, setData] = useState<AnalyticsData | null>(initialData ?? null);
  const [syncing, setSyncing] = useState(false);

  const [preset, setPreset] = useState<RangePreset>("30D");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [methodFilter, setMethodFilter] = useState("ALL");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [skip, setSkip] = useState(0);

  const currentRange: RangeSel = { preset, from: customFrom, to: customTo };
  const isCustom = Boolean(customFrom && customTo);

  async function loadAnalytics(range: RangeSel) {
    try {
      const res = await fetch(`/api/accounts/${accountId}/analytics?${buildRangeQuery(range)}`);
      if (!res.ok) {
        toast.error("Failed to load analytics.");
        return;
      }
      setData(await res.json());
    } catch {
      toast.error("Failed to load analytics.");
    }
  }

  async function loadPayments(range: RangeSel, method: string, category: string, skipVal: number) {
    setPaymentsLoading(true);
    try {
      const sp = buildRangeQuery(range);
      if (method !== "ALL") sp.set("method", method);
      if (category !== "ALL") sp.set("category", category);
      sp.set("skip", String(skipVal));
      sp.set("take", String(TAKE));
      const res = await fetch(`/api/accounts/${accountId}/analytics/payments?${sp}`);
      if (!res.ok) {
        toast.error("Failed to load transactions.");
        return;
      }
      const json = await res.json();
      setPayments(json.rows);
      setPaymentsTotal(json.total);
    } catch {
      toast.error("Failed to load transactions.");
    } finally {
      setPaymentsLoading(false);
    }
  }

  useEffect(() => {
    if (initialData) return; // seeded for a deterministic first render (SSR/testing) — no auto-fetch
    void loadAnalytics(currentRange);
    void loadPayments(currentRange, methodFilter, categoryFilter, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePreset(p: RangePreset) {
    setPreset(p);
    setCustomFrom("");
    setCustomTo("");
    setSkip(0);
    const r: RangeSel = { preset: p, from: "", to: "" };
    void loadAnalytics(r);
    void loadPayments(r, methodFilter, categoryFilter, 0);
  }

  function handleCustomDate(which: "from" | "to", value: string) {
    const nextFrom = which === "from" ? value : customFrom;
    const nextTo = which === "to" ? value : customTo;
    if (which === "from") setCustomFrom(value);
    else setCustomTo(value);
    if (nextFrom && nextTo) {
      setSkip(0);
      const r: RangeSel = { preset, from: nextFrom, to: nextTo };
      void loadAnalytics(r);
      void loadPayments(r, methodFilter, categoryFilter, 0);
    }
  }

  function handleMethodFilter(val: string) {
    setMethodFilter(val);
    setSkip(0);
    void loadPayments(currentRange, val, categoryFilter, 0);
  }

  function handleCategoryFilter(val: string) {
    setCategoryFilter(val);
    setSkip(0);
    void loadPayments(currentRange, methodFilter, val, 0);
  }

  function handlePrev() {
    const next = Math.max(0, skip - TAKE);
    setSkip(next);
    void loadPayments(currentRange, methodFilter, categoryFilter, next);
  }

  function handleNext() {
    const next = skip + TAKE;
    setSkip(next);
    void loadPayments(currentRange, methodFilter, categoryFilter, next);
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/analytics/sync`, { method: "POST" });
      if (!res.ok) {
        toast.error("Failed to sync mock data.");
        return;
      }
      toast.success("Mock data synced.");
      void loadAnalytics(currentRange);
      void loadPayments(currentRange, methodFilter, categoryFilter, skip);
      router.refresh();
    } catch {
      toast.error("Failed to sync mock data.");
    } finally {
      setSyncing(false);
    }
  }

  const kpiTiles = data
    ? [
        { label: "Active Users", value: data.kpis.activeUsers.toLocaleString(), icon: Users },
        { label: "Total Users", value: data.kpis.totalUsers.toLocaleString(), icon: UsersRound },
        { label: "Total Debt", value: money(data.kpis.totalDebt), icon: Wallet },
        { label: "Payments", value: data.kpis.paymentsCount.toLocaleString(), icon: Receipt },
        { label: "Payments Amount", value: money(data.kpis.paymentsAmount), icon: DollarSign },
        { label: "Utility Amount", value: money(data.kpis.utilityAmount), icon: Zap },
      ]
    : [];

  const installTiles = data
    ? [
        { label: "Total Installs", value: data.installs.total.toLocaleString(), icon: Smartphone },
        { label: "iOS", value: data.installs.ios.toLocaleString(), icon: Apple },
        { label: "Android", value: data.installs.android.toLocaleString(), icon: Bot },
        { label: "Activated", value: data.installs.activated.toLocaleString(), icon: UserCheck },
        { label: "Activation Rate", value: `${data.installs.activationRate}%`, icon: Percent },
      ]
    : [];

  const trendGeo = data && data.trend.length > 0 ? buildTrendPath(data.trend, 400, 120) : null;
  const trendTotal = data ? data.trend.reduce((s, t) => s + t.amount, 0) : 0;
  const trendSummary = data
    ? `Payments trend: ${money(trendTotal)} total across ${data.trend.length} day${data.trend.length === 1 ? "" : "s"}`
    : "";

  return (
    <div className="space-y-6">
      {/* Range selector + sync */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Date range" className="flex items-center gap-1">
          {PRESETS.map((p) => {
            const active = !isCustom && preset === p.key;
            return (
              <Button
                key={p.key}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                onClick={() => handlePreset(p.key)}
              >
                {p.label}
              </Button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <Label htmlFor="rangeFrom" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="rangeFrom"
            type="date"
            value={customFrom}
            onChange={(e) => handleCustomDate("from", e.target.value)}
            className="h-7 w-36 text-xs"
          />
          <Label htmlFor="rangeTo" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="rangeTo"
            type="date"
            value={customTo}
            onChange={(e) => handleCustomDate("to", e.target.value)}
            className="h-7 w-36 text-xs"
          />
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleSync}
          disabled={syncing}
          className="ml-auto"
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing…" : "Sync mock data"}
        </Button>
      </div>

      {!data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {kpiTiles.map((t) => {
              const Icon = t.icon;
              return (
                <Card key={t.label} size="sm">
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">{t.label}</CardTitle>
                    <Icon className="size-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-xl font-bold tabular-nums">{t.value}</div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Installs & activation */}
          <Card>
            <CardHeader className="border-b border-border pb-4">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Smartphone className="size-4 text-muted-foreground" />
                Installs &amp; Activation
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                {installTiles.map((t) => {
                  const Icon = t.icon;
                  return (
                    <div key={t.label} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">{t.label}</span>
                        <Icon className="size-4 text-muted-foreground" />
                      </div>
                      <div className="text-xl font-bold tabular-nums">{t.value}</div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

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

          {/* Top users */}
          <Card>
            <CardHeader className="border-b border-border pb-4">
              <CardTitle className="text-base font-semibold">Top Users</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {data.topUsers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <p className="text-sm">No user activity yet</p>
                </div>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableHead className="font-semibold text-foreground">Name</TableHead>
                        <TableHead className="text-right font-semibold text-foreground">Paid</TableHead>
                        <TableHead className="text-right font-semibold text-foreground">Debt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.topUsers.map((u, i) => (
                        <TableRow key={`${u.name}-${i}`}>
                          <TableCell className="font-medium">{u.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{money(u.paid)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {money(u.debt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Transactions */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold">Transactions</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              items={METHOD_FILTER_ITEMS}
              value={methodFilter}
              onValueChange={(val) => {
                if (val) handleMethodFilter(val);
              }}
            >
              <SelectTrigger size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All methods</SelectItem>
                <SelectItem value="CARD">Card</SelectItem>
                <SelectItem value="MANUAL">Manual</SelectItem>
                <SelectItem value="CASH">Cash</SelectItem>
              </SelectContent>
            </Select>
            <Select
              items={CATEGORY_FILTER_ITEMS}
              value={categoryFilter}
              onValueChange={(val) => {
                if (val) handleCategoryFilter(val);
              }}
            >
              <SelectTrigger size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All categories</SelectItem>
                <SelectItem value="APARTMENT">Apartment</SelectItem>
                <SelectItem value="PARKING">Parking</SelectItem>
                <SelectItem value="NON_RESIDENTIAL">Non-Residential</SelectItem>
                <SelectItem value="UTILITY">Utility</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {payments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Receipt className="size-8 mb-2 opacity-40" />
              <p className="text-sm">{paymentsLoading ? "Loading…" : "No transactions for this range"}</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="font-semibold text-foreground">Date</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Amount</TableHead>
                    <TableHead className="font-semibold text-foreground">Method</TableHead>
                    <TableHead className="font-semibold text-foreground">Category</TableHead>
                    <TableHead className="font-semibold text-foreground">User</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-muted-foreground">
                        {new Date(p.occurredAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{money(p.amount)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-medium ${colorFor("method", p.method).badge}`}>
                          {METHOD_LABELS[p.method] ?? p.method}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-medium ${colorFor("category", p.category).badge}`}>
                          {CATEGORY_LABELS[p.category] ?? p.category}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-foreground">{p.userName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              {paymentsTotal === 0
                ? "0 results"
                : `Showing ${skip + 1}–${Math.min(skip + TAKE, paymentsTotal)} of ${paymentsTotal}`}
            </p>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handlePrev}
                disabled={skip === 0 || paymentsLoading}
              >
                <ChevronLeft />
                Prev
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleNext}
                disabled={skip + TAKE >= paymentsTotal || paymentsLoading}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
