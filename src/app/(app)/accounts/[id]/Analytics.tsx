"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Users,
  UsersRound,
  Wallet,
  Receipt,
  DollarSign,
  Zap,
  ChevronLeft,
  ChevronRight,
  Smartphone,
  Apple,
  Bot,
  UserCheck,
  Percent,
  AlertCircle,
  Link2Off,
  Download,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CATEGORY_LABELS, CATEGORY_ORDER, CATEGORY_COLORS } from "@/lib/analytics/categories";
import { formatMoney } from "@/lib/money";

type RangePreset = "DAILY" | "7D" | "30D" | "90D" | "1Y";
type RangeSel = { preset: RangePreset; from: string; to: string };

// Mirrors AnalyticsStatus in src/lib/tenant/partner-analytics.ts. "ok" means live data;
// everything else is a typed, actionable message distinct from "no data for this range".
type AnalyticsStatus = "ok" | "not-configured" | "invalid-key" | "unknown-partner" | "unavailable";

type Kpis = {
  activeUsers: number;
  totalUsers: number;
  totalDebt: number;
  paymentsCount: number;
  paymentsAmount: number;
  utilityCount: number;
  utilityAmount: number;
};
type MethodBreakdown = { method: string; amount: number };
type CategoryBreakdown = { category: string; amount: number };
type Installs = { total: number; ios: number; android: number; activated: number; activationRate: number };

type AnalyticsData = {
  status?: AnalyticsStatus; // absent is treated as "ok" (e.g. test fixtures)
  kpis: Kpis;
  byMethod: MethodBreakdown[];
  byCategory: CategoryBreakdown[];
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

// Local, manually-entered platform-download snapshots — NOT from the partner API. One row per
// account per day; see src/lib/tenant/platform-installs.ts.
type InstallSnapshot = {
  id: string;
  capturedOn: string;
  iosInstalls: number;
  androidInstalls: number;
};

type Props = {
  accountId: string;
  initialData?: AnalyticsData;
  isAdmin?: boolean;
};

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "DAILY", label: "Daily" },
  { key: "7D", label: "7D" },
  { key: "30D", label: "30D" },
  { key: "90D", label: "90D" },
  { key: "1Y", label: "1Y" },
];

const PAGE_SIZE = 25;

const METHOD_LABELS: Record<string, string> = { CARD: "Card", MANUAL: "Manual", CASH: "Cash" };
const METHOD_ORDER = ["CARD", "MANUAL", "CASH"];

// Typed, non-"ok" states rendered as a single guidance card instead of empty charts.
const STATUS_CONTENT: Record<Exclude<AnalyticsStatus, "ok">, { title: string; body: string }> = {
  "not-configured": {
    title: "Analytics not connected",
    body: "Link this account to the analytics provider by setting its partner name and API key in Account Details.",
  },
  "invalid-key": {
    title: "API key rejected",
    body: "The analytics provider rejected this account's API key. Update the key in Account Details and try again.",
  },
  "unknown-partner": {
    title: "Partner not recognized",
    body: "The analytics provider doesn't recognize this account's partner name. Check the partner name in Account Details.",
  },
  unavailable: {
    title: "Analytics unavailable",
    body: "The analytics service is temporarily unavailable. Please try again in a little while.",
  },
};

function colorFor(kind: "method" | "category", key: string) {
  const order = kind === "method" ? METHOD_ORDER : CATEGORY_ORDER;
  const idx = order.indexOf(key);
  return CATEGORY_COLORS[idx >= 0 ? idx : 0];
}

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

// Platform Downloads chart: iOS vs Android, our own local manual entries — never fed by the
// partner API. Two currency-free count series sharing one y-axis. Colors are fixed hexes
// (distinct from the categorical token ramp) matching the house inline-SVG chart convention.
type DownloadPoint = { date: string; ios: number; android: number };
type DownloadSeriesKey = "ios" | "android";
const DOWNLOAD_SERIES: { key: DownloadSeriesKey; label: string; color: string }[] = [
  { key: "ios", label: "iOS", color: "#0284C7" },
  { key: "android", label: "Android", color: "#16A34A" },
];

function buildDownloadPaths(points: DownloadPoint[], width: number, height: number) {
  const max = Math.max(1, ...points.flatMap((p) => [p.ios, p.android]));
  const pad = height * 0.1;
  const usableH = height - pad * 2;
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const xAt = (i: number) => (points.length > 1 ? i * stepX : width / 2);
  const yAt = (v: number) => pad + usableH - (v / max) * usableH;
  const lines = DOWNLOAD_SERIES.map((s) => {
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p[s.key]).toFixed(1)}`).join(" ");
    const last = points.length > 0 ? { x: xAt(points.length - 1), y: yAt(points[points.length - 1][s.key]) } : null;
    return { ...s, d, last };
  });
  // Recessive horizontal gridlines at 0/25/50/75/100% of the shared scale.
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => pad + usableH * f);
  return { lines, gridY };
}

// Direct-label a series at its final point only when it won't collide with a neighbor —
// the legend below always carries identity regardless, so a skipped label never leaves a
// series unidentified (color is never the only cue).
function pickDirectLabels(lines: { key: string; last: { x: number; y: number } | null }[], minGapPx: number): Set<string> {
  const withLast = lines.filter((l): l is typeof l & { last: { x: number; y: number } } => l.last !== null);
  const sorted = [...withLast].sort((a, b) => a.last.y - b.last.y);
  const shown = new Set<string>();
  let lastY: number | null = null;
  for (const l of sorted) {
    if (lastY === null || Math.abs(l.last.y - lastY) >= minGapPx) {
      shown.add(l.key);
      lastY = l.last.y;
    }
  }
  return shown;
}

function formatSnapshotDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function BreakdownRows({
  kind,
  rows,
}: {
  kind: "method" | "category";
  rows: { key: string; amount: number }[];
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
              {formatMoney(r.amount)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StatusCard({ status }: { status: Exclude<AnalyticsStatus, "ok"> }) {
  const content = STATUS_CONTENT[status];
  const Icon = status === "not-configured" ? Link2Off : AlertCircle;
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <Icon className="size-8 opacity-40 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{content.title}</p>
        <p className="text-sm text-muted-foreground max-w-md">{content.body}</p>
      </CardContent>
    </Card>
  );
}

export function Analytics({ accountId, initialData, isAdmin = false }: Props) {
  const [data, setData] = useState<AnalyticsData | null>(initialData ?? null);

  const [preset, setPreset] = useState<RangePreset>("30D");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [paymentsLoading, setPaymentsLoading] = useState(false);

  // Local, manually-entered platform-download snapshots (separate from the live `data` above).
  // null = still loading; [] = loaded, no snapshots yet.
  const [snapshots, setSnapshots] = useState<InstallSnapshot[] | null>(null);
  const [snapDate, setSnapDate] = useState("");
  const [snapIos, setSnapIos] = useState("");
  const [snapAndroid, setSnapAndroid] = useState("");
  const [snapSaving, setSnapSaving] = useState(false);

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

  async function loadPayments(range: RangeSel, pageVal: number) {
    setPaymentsLoading(true);
    try {
      const sp = buildRangeQuery(range);
      sp.set("page", String(pageVal));
      sp.set("page_size", String(PAGE_SIZE));
      const res = await fetch(`/api/accounts/${accountId}/analytics/payments?${sp}`);
      if (!res.ok) {
        toast.error("Failed to load transactions.");
        return;
      }
      const json = await res.json();
      setPayments(json.rows);
      setPaymentsTotal(json.total);
      setPageCount(json.pageCount);
      setPage(json.page);
    } catch {
      toast.error("Failed to load transactions.");
    } finally {
      setPaymentsLoading(false);
    }
  }

  async function loadSnapshots() {
    try {
      const res = await fetch(`/api/accounts/${accountId}/platform-installs`);
      if (!res.ok) {
        toast.error("Failed to load platform downloads.");
        return;
      }
      setSnapshots(await res.json());
    } catch {
      toast.error("Failed to load platform downloads.");
    }
  }

  async function handleAddSnapshot(e: React.FormEvent) {
    e.preventDefault();
    setSnapSaving(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/platform-installs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capturedOn: snapDate,
          iosInstalls: Number(snapIos),
          androidInstalls: Number(snapAndroid),
        }),
      });
      if (!res.ok) {
        toast.error("Failed to save platform downloads. Please try again.");
        return;
      }
      toast.success("Platform downloads saved.");
      setSnapDate("");
      setSnapIos("");
      setSnapAndroid("");
      await loadSnapshots();
    } catch {
      toast.error("Failed to save platform downloads. Please try again.");
    } finally {
      setSnapSaving(false);
    }
  }

  useEffect(() => {
    if (initialData) return; // seeded for a deterministic first render (SSR/testing) — no auto-fetch
    // These loaders setState only after their awaited fetch resolves (standard fetch-on-mount),
    // not synchronously, so the cascading-render warning doesn't apply here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAnalytics(currentRange);
    void loadPayments(currentRange, 1);
    void loadSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePreset(p: RangePreset) {
    setPreset(p);
    setCustomFrom("");
    setCustomTo("");
    setPage(1);
    const r: RangeSel = { preset: p, from: "", to: "" };
    void loadAnalytics(r);
    void loadPayments(r, 1);
  }

  function handleCustomDate(which: "from" | "to", value: string) {
    const nextFrom = which === "from" ? value : customFrom;
    const nextTo = which === "to" ? value : customTo;
    if (which === "from") setCustomFrom(value);
    else setCustomTo(value);
    if (nextFrom && nextTo) {
      setPage(1);
      const r: RangeSel = { preset, from: nextFrom, to: nextTo };
      void loadAnalytics(r);
      void loadPayments(r, 1);
    }
  }

  function handlePrev() {
    const next = Math.max(1, page - 1);
    setPage(next);
    void loadPayments(currentRange, next);
  }

  function handleNext() {
    const next = page + 1;
    setPage(next);
    void loadPayments(currentRange, next);
  }

  const status: AnalyticsStatus = data?.status ?? "ok";

  const kpiTiles = data
    ? [
        { label: "Active Users", value: data.kpis.activeUsers.toLocaleString(), icon: Users },
        { label: "Total Users", value: data.kpis.totalUsers.toLocaleString(), icon: UsersRound },
        { label: "Total Debt", value: formatMoney(data.kpis.totalDebt), icon: Wallet },
        { label: "Payments", value: data.kpis.paymentsCount.toLocaleString(), icon: Receipt },
        { label: "Payments Amount", value: formatMoney(data.kpis.paymentsAmount), icon: DollarSign },
        { label: "Utility Amount", value: formatMoney(data.kpis.utilityAmount), icon: Zap },
      ]
    : [];

  const installTiles = data
    ? [
        { label: "Active on App", value: data.installs.total.toLocaleString(), icon: Smartphone },
        { label: "iOS", value: data.installs.ios.toLocaleString(), icon: Apple },
        { label: "Android", value: data.installs.android.toLocaleString(), icon: Bot },
        { label: "Activated", value: data.installs.activated.toLocaleString(), icon: UserCheck },
        { label: "Activation Rate", value: `${data.installs.activationRate}%`, icon: Percent },
      ]
    : [];

  // Platform Downloads chart geometry — independent of `data`/`status` above (our own local
  // data), so it stays visible even when the live partner-API analytics are unconfigured/erroring.
  const downloadPoints: DownloadPoint[] = (snapshots ?? []).map((s) => ({
    date: s.capturedOn,
    ios: s.iosInstalls,
    android: s.androidInstalls,
  }));
  const downloadsGeo = downloadPoints.length > 0 ? buildDownloadPaths(downloadPoints, 400, 130) : null;
  const downloadsHasData = downloadPoints.some((p) => p.ios > 0 || p.android > 0);
  const downloadTotals: Record<DownloadSeriesKey, number> = {
    ios: downloadPoints.reduce((s, p) => s + p.ios, 0),
    android: downloadPoints.reduce((s, p) => s + p.android, 0),
  };
  const downloadsSummary = `Platform downloads: ${downloadTotals.ios.toLocaleString()} iOS, ${downloadTotals.android.toLocaleString()} Android, across ${downloadPoints.length} day${downloadPoints.length === 1 ? "" : "s"}`;
  const downloadsDirectLabels = downloadsGeo ? pickDirectLabels(downloadsGeo.lines, 14) : new Set<string>();

  return (
    <div className="space-y-6">
      {/* Range selector */}
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
      </div>

      {!data ? (
        <div className="space-y-6" aria-busy="true" aria-label="Loading analytics">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-40 rounded-xl" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        </div>
      ) : status !== "ok" ? (
        <StatusCard status={status} />
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

          {/* Breakdowns */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-base font-semibold">By Payment Method</CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <BreakdownRows
                  kind="method"
                  rows={data.byMethod.map((r) => ({ key: r.method, amount: r.amount }))}
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
                  rows={data.byCategory.map((r) => ({ key: r.category, amount: r.amount }))}
                />
              </CardContent>
            </Card>
          </div>

          {/* Transactions */}
          <Card>
            <CardHeader className="border-b border-border pb-4">
              <CardTitle className="text-base font-semibold">Transactions</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              {payments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <Receipt className="size-8 mb-2 opacity-40" />
                  <p className="text-sm">{paymentsLoading ? "Loading…" : "No transactions for this range"}</p>
                </div>
              ) : (
                <div className="rounded-lg border border-border overflow-x-auto">
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
                          <TableCell className="text-right tabular-nums font-medium">{formatMoney(p.amount)}</TableCell>
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
                    : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, paymentsTotal)} of ${paymentsTotal}`}
                </p>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handlePrev}
                    disabled={page <= 1 || paymentsLoading}
                  >
                    <ChevronLeft />
                    Prev
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleNext}
                    disabled={page >= pageCount || paymentsLoading}
                  >
                    Next
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Platform Downloads: OUR local manually-entered data, shown in parallel with the live
          "Active on App" figure above (not derived from it) — independent of the live-analytics
          status above, so it stays visible even if the partner API is unconfigured/erroring. */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Download className="size-4 text-muted-foreground" />
            Platform Downloads
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {snapshots === null ? (
            <Skeleton className="h-40 rounded-lg" aria-busy="true" aria-label="Loading platform downloads" />
          ) : !downloadsHasData ? (
            <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
              <Download className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No downloads recorded yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              <svg
                viewBox="0 0 400 130"
                preserveAspectRatio="none"
                className="w-full h-36"
                role="img"
                aria-label={downloadsSummary}
              >
                <title>{downloadsSummary}</title>
                {downloadsGeo?.gridY.map((y, i) => (
                  <line
                    key={i}
                    x1={0}
                    x2={400}
                    y1={y}
                    y2={y}
                    className="stroke-border"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {downloadsGeo?.lines.map((s) => (
                  <path
                    key={s.key}
                    d={s.d}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
                {downloadsGeo?.lines
                  .filter((s) => s.last && downloadsDirectLabels.has(s.key))
                  .map((s) => (
                    <g key={`label-${s.key}`}>
                      <circle cx={s.last!.x} cy={s.last!.y} r={2.5} fill={s.color} />
                      <text
                        x={s.last!.x > 340 ? s.last!.x - 6 : s.last!.x + 6}
                        y={s.last!.y}
                        textAnchor={s.last!.x > 340 ? "end" : "start"}
                        dominantBaseline="middle"
                        className="fill-muted-foreground text-[9px]"
                      >
                        {s.label}
                      </text>
                    </g>
                  ))}
              </svg>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{formatSnapshotDate(downloadPoints[0].date)}</span>
                <span>{formatSnapshotDate(downloadPoints[downloadPoints.length - 1].date)}</span>
              </div>
              {/* Legend — mandatory for 2 series; identity is never color-alone. */}
              <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm pt-1">
                {DOWNLOAD_SERIES.map((s) => (
                  <li key={s.key} className="flex items-center gap-1.5 text-foreground">
                    <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} aria-hidden="true" />
                    {s.label}
                    <span className="text-muted-foreground tabular-nums">{downloadTotals[s.key].toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manual entry (admin only) — local data, upserts the day on the [accountId, capturedOn] key */}
      {isAdmin && (
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">Log Platform Downloads</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleAddSnapshot} className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="snapDate">
                    Date <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="snapDate"
                    type="date"
                    value={snapDate}
                    onChange={(e) => setSnapDate(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="snapIos">
                    iOS <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="snapIos"
                    type="number"
                    min="0"
                    step="1"
                    value={snapIos}
                    onChange={(e) => setSnapIos(e.target.value)}
                    className="tabular-nums"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="snapAndroid">
                    Android <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="snapAndroid"
                    type="number"
                    min="0"
                    step="1"
                    value={snapAndroid}
                    onChange={(e) => setSnapAndroid(e.target.value)}
                    className="tabular-nums"
                    required
                  />
                </div>
              </div>

              <Button type="submit" size="sm" disabled={snapSaving}>
                {snapSaving ? "Saving…" : "Save downloads"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
