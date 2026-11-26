"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PERIOD_PRESETS, isPeriodPreset, type PeriodPreset } from "@/lib/period-presets";

export type FilterOption = { value: string; label: string };

const PERIOD_LABELS: Record<PeriodPreset, string> = {
  "this-month": "This month",
  "last-month": "Last month",
  "this-year": "This year",
  custom: "Custom range",
};
const ALL_BUILDINGS = "__all__";

// URL-driven filter bar. State lives in search params (?period, ?from, ?to, ?q, ?building, ?status)
// so views are shareable and server-renderable; the page reads the same params in its server
// component. Every control is optional: pass only the props a page needs. A control's param is
// removed from the URL when it is at its default (period = `defaultPreset`, status = the FIRST
// option, building = "all").
export function FilterBar({
  showPeriod,
  defaultPreset = "this-month",
  showSearch,
  searchPlaceholder = "Search buildings...",
  buildingOptions,
  statusOptions,
  statusLabel = "Status",
  className,
}: {
  showPeriod?: boolean;
  defaultPreset?: PeriodPreset;
  showSearch?: boolean;
  searchPlaceholder?: string;
  buildingOptions?: FilterOption[];
  statusOptions?: FilterOption[];
  statusLabel?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [q, setQ] = useState(params.get("q") ?? "");

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const rawPeriod = params.get("period");
  const period: PeriodPreset = isPeriodPreset(rawPeriod) ? rawPeriod : defaultPreset;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  const periodItems: Record<string, string> = PERIOD_LABELS;
  const buildingItems: Record<string, string> = {
    [ALL_BUILDINGS]: "All buildings",
    ...Object.fromEntries((buildingOptions ?? []).map((o) => [o.value, o.label])),
  };
  const statusItems: Record<string, string> = Object.fromEntries((statusOptions ?? []).map((o) => [o.value, o.label]));
  const statusDefault = statusOptions?.[0]?.value;

  return (
    <div className={className ?? "flex flex-wrap items-center gap-2"}>
      {showPeriod && (
        <>
          <Select
            items={periodItems}
            value={period}
            onValueChange={(v) => {
              if (!isPeriodPreset(v)) return;
              // Leaving "custom" drops the explicit dates, which would otherwise override the preset.
              update({ period: v === defaultPreset ? null : v, ...(v === "custom" ? {} : { from: null, to: null }) });
            }}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_PRESETS.map((p) => (
                <SelectItem key={p} value={p}>{PERIOD_LABELS[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {period === "custom" && (
            <>
              <Input
                type="date"
                aria-label="From date"
                value={from}
                max={to || undefined}
                onChange={(e) => update({ from: e.target.value || null })}
                className="h-8 w-36 text-sm"
              />
              <span className="text-sm text-muted-foreground" aria-hidden>to</span>
              <Input
                type="date"
                aria-label="To date"
                value={to}
                min={from || undefined}
                onChange={(e) => update({ to: e.target.value || null })}
                className="h-8 w-36 text-sm"
              />
            </>
          )}
        </>
      )}
      {showSearch && (
        <Input
          type="search"
          aria-label="Search by building name"
          placeholder={searchPlaceholder}
          value={q}
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => update({ q: v.trim() || null }), 300);
          }}
          className="h-8 w-56 text-sm"
        />
      )}
      {buildingOptions && (
        <Select
          items={buildingItems}
          value={params.get("building") ?? ALL_BUILDINGS}
          onValueChange={(v) => { if (v) update({ building: v === ALL_BUILDINGS ? null : v }); }}
        >
          <SelectTrigger size="sm" className="w-44" aria-label="Building">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_BUILDINGS}>All buildings</SelectItem>
            {buildingOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {statusOptions && statusOptions.length > 0 && (
        <Select
          items={statusItems}
          value={params.get("status") ?? statusDefault ?? ""}
          onValueChange={(v) => { if (v) update({ status: v === statusDefault ? null : v }); }}
        >
          <SelectTrigger size="sm" className="w-36" aria-label={statusLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
