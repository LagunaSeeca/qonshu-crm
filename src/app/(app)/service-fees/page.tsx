import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/guards";
import { prisma } from "@/db/client";
import { accountScopeWhere } from "@/lib/tenant/scope";
import { listCompanyServiceFees, type ServiceFeeListStatus } from "@/lib/tenant/service-fees";
import { isPeriodPreset, resolvePeriodPreset, BAKU_UTC_OFFSET_HOURS } from "@/lib/period-presets";
import { PageHeader } from "@/components/PageHeader";
import { FilterBar } from "@/components/FilterBar";
import { ServiceFeesView } from "./ServiceFeesView";

type Sp = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// FIRST entry is the default ("All") and is stripped from the URL by FilterBar.
const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "PAID", label: "Paid" },
  { value: "UNPAID", label: "Unpaid" },
  { value: "OVERDUE", label: "Overdue" },
];

// Default period is the whole year, not the month: an unpaid fee from last month is exactly what
// this page exists to surface, and a "this month" default would hide it behind a filter.
const DEFAULT_PRESET = "this-year" as const;

// Baku-local "YYYY-MM" for the Generate control's default, computed on the server so the first
// client render matches (no hydration drift around midnight on the 1st).
function currentBakuMonth(now = new Date()) {
  const l = new Date(now.getTime() + BAKU_UTC_OFFSET_HOURS * 3600000);
  return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function ServiceFeesPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const isPartner = user.role === "PARTNER_VIEWER";
  const rawPeriod = first(sp.period);
  const rawStatus = first(sp.status);
  const status: ServiceFeeListStatus | undefined =
    rawStatus === "PAID" || rawStatus === "UNPAID" || rawStatus === "OVERDUE" ? rawStatus : undefined;
  const building = first(sp.building) || undefined;

  // Baku local time. A bad range must render a message, not crash the page.
  let period: { from: Date; to: Date } | null = null;
  try {
    period = resolvePeriodPreset({
      preset: isPeriodPreset(rawPeriod) ? rawPeriod : DEFAULT_PRESET,
      from: first(sp.from),
      to: first(sp.to),
    });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }

  // Picker options come from the caller's whole scope so narrowing to one building doesn't drop
  // the others. A partner login has exactly one building, so it gets no picker.
  const scoped = isPartner
    ? []
    : await prisma.account.findMany({ where: accountScopeWhere(user), select: { id: true, name: true }, orderBy: { name: "asc" } });
  const buildingOptions = scoped.map((a) => ({ value: a.id, label: a.name }));

  const data = period
    ? await listCompanyServiceFees(prisma, user, { status, from: period.from, to: period.to, accountId: building })
    : null;

  // ZERO-ROW DECISION: under a status filter the service still returns every building, with zeros
  // for those that have no matching fee. Those rows answer nothing ("Overdue" listing 40 buildings
  // that owe 0 buries the 2 that do), so they are dropped. With status = All they stay: a building
  // with no fees and no rate is precisely the thing worth seeing. Totals are unaffected.
  const rows = data ? (status ? data.rows.filter((r) => r.billed > 0) : data.rows) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Service fees"
        subtitle="What accounts pay us monthly for using our app — separate from resident payments and settlements"
      />

      <Suspense fallback={null}>
        <FilterBar
          showPeriod
          defaultPreset={DEFAULT_PRESET}
          buildingOptions={isPartner ? undefined : buildingOptions}
          statusOptions={STATUS_OPTIONS}
        />
      </Suspense>

      {!data ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Invalid date range</p>
          <p className="text-xs text-muted-foreground mt-1">
            Check that both dates are valid and that the start is not after the end.
          </p>
        </div>
      ) : (
        <Suspense fallback={null}>
          <ServiceFeesView
            totals={data.totals}
            rows={rows}
            isPartner={isPartner}
            canPrice={can(user, "write_settlements")}
            filtered={Boolean(status || building)}
            sortKey={first(sp.sort)}
            sortDir={first(sp.dir)}
            defaultMonth={currentBakuMonth()}
          />
        </Suspense>
      )}
    </div>
  );
}
