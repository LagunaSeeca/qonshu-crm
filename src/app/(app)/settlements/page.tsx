import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/guards";
import { prisma } from "@/db/client";
import { listCompanySettlements } from "@/lib/tenant/settlements";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddSettlementEntry } from "./AddSettlementEntry";
import { PageHeader } from "@/components/PageHeader";
import { formatMoney } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { FilterBar } from "@/components/FilterBar";
import { resolvePeriodPreset, isPeriodPreset } from "@/lib/period-presets";
import { accountScopeWhere } from "@/lib/tenant/scope";

type Sp = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "owed", label: "Owed" },
  { value: "settled", label: "Settled" },
];

// Self-collecting buildings hold their own money, so Qonshu owes them nothing. "—" already means
// "upstream unknown" on this page, and 0 would read as "settled", so a SELF row's Owed uses this
// distinct muted marker instead. Transferred is NOT marked this way: it is a real, known figure
// even for a SELF building (see the table cell comment below).
const NA = <span className="text-muted-foreground font-normal" title="Not applicable: this building collects its own money">n/a</span>;

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // A MEMBER can reach this by bookmark/history/KPI link; bounce instead of letting the guard throw a 500.
  if (!can(user, "view_settlements")) redirect("/dashboard");

  const sp = await searchParams;
  const rawPeriod = first(sp.period);
  const q = first(sp.q)?.trim() || undefined;
  const building = first(sp.building) || undefined;
  const rawStatus = first(sp.status);
  const status = rawStatus === "owed" || rawStatus === "settled" ? rawStatus : undefined;

  // Periods are Baku local time. A bad range (e.g. from after to) must render a message, not crash.
  let period: { from: Date; to: Date } | null = null;
  try {
    period = resolvePeriodPreset({
      preset: isPeriodPreset(rawPeriod) ? rawPeriod : undefined,
      from: first(sp.from),
      to: first(sp.to),
    });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }

  // Building picker options come from the caller's whole scope, not the filtered rows, so
  // narrowing to one building doesn't remove the others from the dropdown.
  const scopedAccounts = await prisma.account.findMany({
    where: accountScopeWhere(user),
    select: { id: true, name: true, collectionMode: true },
    orderBy: { name: "asc" },
  });
  const buildingOptions = scopedAccounts.map((a) => ({ value: a.id, label: a.name }));
  const transferTargets = scopedAccounts.filter((a) => a.collectionMode !== "SELF").map((a) => ({ id: a.id, name: a.name }));

  const result = period ? await listCompanySettlements(prisma, user, period, { q, accountId: building, status }) : null;
  const totals = result?.totals;
  const rows = result?.rows ?? [];

  // Collected comes from the partner API per request and can legitimately be UNKNOWN (upstream
  // down, key rejected, no link). The service omits the key in that case rather than sending 0,
  // because a ₼0 Collected reads as "collected nothing" — a false statement about money. Render
  // the absence as "—", never as a number, and never with `?? 0`.
  const money = (n: number | undefined) => (n === undefined ? "—" : formatMoney(n));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settlements"
        subtitle="Company-wide bank-balance and cash-transfer registry"
        action={
          can(user, "write_settlements") && (
            <AddSettlementEntry accounts={transferTargets} />
          )
        }
      />

      <Suspense fallback={null}>
        <FilterBar showPeriod showSearch buildingOptions={buildingOptions} statusOptions={STATUS_OPTIONS} />
      </Suspense>

      {!totals ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Invalid date range</p>
          <p className="text-xs text-muted-foreground mt-1">
            Check that both dates are valid and that the start is not after the end.
          </p>
        </div>
      ) : (<>
      {/* Partial-data disclosure. Without this the totals below are understated by however much
          the unreachable accounts had collected, while still reading as authoritative. Transferred
          is NOT affected — those are our own DB rows and always known — which is also why
          Collected - Transferred != Owed while this banner is showing. */}
      {totals.partial && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Partial data</p>
          <p className="text-xs text-muted-foreground mt-1">
            Collected could not be retrieved for {totals.degradedAccountIds.length}{" "}
            {totals.degradedAccountIds.length === 1 ? "account" : "accounts"}, shown as “—” below.
            The Collected and Owed totals cover only the accounts that responded.
          </p>
        </div>
      )}

      {/* Totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Collected</CardTitle>
            <ArrowDownCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(totals.collected)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Transferred</CardTitle>
            <ArrowUpCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{formatMoney(totals.transferred)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Owed</CardTitle>
            <Landmark className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-foreground">{money(totals.owed)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Deliberately NOT part of the Collected card: this is card money the self-collecting
          buildings took themselves. Qonshu never held it, so adding it to Collected would
          overstate what Qonshu holds and owes. */}
      {totals.selfCollected > 0 && (
        <p className="text-xs text-muted-foreground">
          Collected by self-collecting buildings:{" "}
          <span className="tabular-nums font-medium text-foreground">{formatMoney(totals.selfCollected)}</span>
          {" "}(not included in the totals above; Qonshu never held this money)
        </p>
      )}

      {/* Registry by partner */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed border-border">
          <Landmark className="size-8 mb-2 opacity-40 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">
            {q || building || status ? "No buildings match these filters" : "No accounts yet"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {q || building || status ? "Try clearing the search or status filter" : "Settlement balances will appear once accounts have entries"}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="font-semibold text-foreground">Partner</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Collected</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Transferred</TableHead>
                <TableHead className="text-right font-semibold text-foreground">Owed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.accountId} className="hover:bg-muted/40 transition-colors duration-150">
                  <TableCell className="font-medium">
                    {/* Partners can't open account detail (/accounts/[id] bounces them back) — plain
                        text instead of a dead link that would blank on click. */}
                    {user.role === "PARTNER_VIEWER" ? (
                      r.accountName
                    ) : (
                      <Link
                        href={`/accounts/${r.accountId}`}
                        className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                      >
                        {r.accountName}
                      </Link>
                    )}
                    {r.collectionMode === "SELF" && (
                      <Badge variant="secondary" className="ml-2 align-middle">Self-collecting</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.collected)}</TableCell>
                  {/*
                    Transferred is a real figure for a SELF row too — the service returns it
                    because transfer rows are history, and a building may have been settled
                    through Qonshu before switching to self-collection. Only Owed is inapplicable.
                  */}
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(r.transferred)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {r.collectionMode === "SELF" ? NA : money(r.remaining ?? r.owed)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      </>)}
    </div>
  );
}
