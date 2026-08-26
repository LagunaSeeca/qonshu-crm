"use client";
import { useEffect, useState } from "react";
import {
  Boxes,
  Building2,
  Layers,
  Car,
  Store,
  Briefcase,
  ChevronRight,
  AlertCircle,
  Link2Off,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

// ---- Types mirror the normalized shape returned by GET /api/accounts/[id]/objects ----
type Unit = {
  id: number;
  number: string;
  ownerId: number | null;
  ownerName: string | null;
  ownerMobile: string | null;
  debt: number;
  balance: number;
  net: number;
};
type PropertyUnit = Unit & { type: string };
type Block = { id: number; name: string; apartments: Unit[] };
type Building = {
  id: number;
  name: string;
  blocks: Block[];
  // Flat lists live directly on the building — NOT nested under blocks.
  parkings: Unit[];
  properties: PropertyUnit[];
  offices: Unit[];
};

type OkPayload = {
  status: "ok";
  partner: string;
  complexType: "RESIDENTIAL" | "COMMERCIAL";
  buildings: Building[];
};

// Every state the API can resolve to, plus a local "error" catch-all for generic
// { error } bodies (401/404/500) and network failures.
type ObjectsState =
  | OkPayload
  | { status: "not_configured" }
  | { status: "invalid_api_key" }
  | { status: "unknown_partner" }
  | { status: "partner_api_unavailable" }
  | { status: "error" };

const KNOWN_STATUSES = new Set([
  "ok",
  "not_configured",
  "invalid_api_key",
  "unknown_partner",
  "partner_api_unavailable",
]);

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// net < 0 → owes (red); net > 0 → credit (green); 0 → neutral.
function netClass(net: number) {
  if (net < 0) return "text-red-600 dark:text-red-400";
  if (net > 0) return "text-green-600 dark:text-green-400";
  return "text-muted-foreground";
}

function unitCount(b: Building) {
  return (
    b.blocks.reduce((sum, blk) => sum + blk.apartments.length, 0) +
    b.parkings.length +
    b.properties.length +
    b.offices.length
  );
}

type Props = { accountId: string };

// ---- Typed guidance cards for every non-"ok" state ----
const STATUS_CONTENT: Record<
  Exclude<ObjectsState["status"], "ok">,
  { title: string; body: string; retry?: boolean }
> = {
  not_configured: {
    title: "Objects not connected",
    body: "Link this account to the partner provider by setting its partner name and Partner API key in Account Details, then this complex's structure will appear here.",
  },
  invalid_api_key: {
    title: "API key rejected",
    body: "The partner provider rejected this account's Partner API key. Update the key in Account Details and try again.",
  },
  unknown_partner: {
    title: "Partner not recognized",
    body: "The partner provider doesn't recognize this account's partner name. Check the partner name in Account Details.",
  },
  partner_api_unavailable: {
    title: "Partner service unavailable",
    body: "The partner service is temporarily unavailable. Please try again in a little while.",
    retry: true,
  },
  error: {
    title: "Couldn't load objects",
    body: "Something went wrong loading this complex's structure. Please try again.",
    retry: true,
  },
};

function StatusCard({
  status,
  onRetry,
}: {
  status: Exclude<ObjectsState["status"], "ok">;
  onRetry: () => void;
}) {
  const content = STATUS_CONTENT[status];
  const Icon = status === "not_configured" ? Link2Off : AlertCircle;
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <Icon className="size-8 opacity-40 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{content.title}</p>
        <p className="text-sm text-muted-foreground max-w-md">{content.body}</p>
        {content.retry && (
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            Try again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ComplexTypeBadge({ type }: { type: OkPayload["complexType"] }) {
  const cls =
    type === "RESIDENTIAL"
      ? "text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950"
      : "text-violet-700 border-violet-300 bg-violet-50 dark:text-violet-400 dark:border-violet-700 dark:bg-violet-950";
  return (
    <Badge variant="outline" className={`font-medium ${cls}`}>
      {type === "RESIDENTIAL" ? "Residential" : "Commercial"}
    </Badge>
  );
}

function UnitTable({
  units,
  numberLabel,
  showType = false,
}: {
  units: (Unit & { type?: string })[];
  numberLabel: string;
  showType?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="font-semibold text-foreground">{numberLabel}</TableHead>
            <TableHead className="font-semibold text-foreground">Owner</TableHead>
            {showType && <TableHead className="font-semibold text-foreground">Type</TableHead>}
            <TableHead className="text-right font-semibold text-foreground">Debt</TableHead>
            <TableHead className="text-right font-semibold text-foreground">Balance</TableHead>
            <TableHead className="text-right font-semibold text-foreground">Net</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {units.map((u) => (
            <TableRow key={u.id}>
              <TableCell className="font-medium text-foreground whitespace-nowrap">{u.number}</TableCell>
              <TableCell>
                {u.ownerId === null ? (
                  <Badge variant="outline" className="border-dashed text-muted-foreground font-normal">
                    Vacant
                  </Badge>
                ) : (
                  <div className="flex flex-col leading-tight">
                    <span className="text-foreground">{u.ownerName ?? "—"}</span>
                    {u.ownerMobile && (
                      <span className="text-xs text-muted-foreground tabular-nums">{u.ownerMobile}</span>
                    )}
                  </div>
                )}
              </TableCell>
              {showType && (
                <TableCell>
                  <Badge variant="outline" className="font-medium text-foreground capitalize">
                    {u.type ?? "—"}
                  </Badge>
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums text-foreground">{money(u.debt)}</TableCell>
              <TableCell className="text-right tabular-nums text-foreground">{money(u.balance)}</TableCell>
              <TableCell className={cn("text-right tabular-nums font-medium", netClass(u.net))}>
                {money(u.net)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FlatSection({
  title,
  Icon,
  units,
  numberLabel,
  showType = false,
}: {
  title: string;
  Icon: typeof Car;
  units: (Unit & { type?: string })[];
  numberLabel: string;
  showType?: boolean;
}) {
  if (units.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {units.length}
        </span>
      </div>
      <UnitTable units={units} numberLabel={numberLabel} showType={showType} />
    </div>
  );
}

export function Objects({ accountId }: Props) {
  // null = loading; otherwise a discriminated state.
  const [state, setState] = useState<ObjectsState | null>(null);
  const [collapsedBuildings, setCollapsedBuildings] = useState<Set<number>>(new Set());
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const res = await fetch(`/api/accounts/${accountId}/objects`);
      // Error statuses arrive with non-2xx codes but still carry a typed { status } body,
      // so parse regardless of res.ok and branch on the status field.
      const body = await res.json().catch(() => null);
      if (body && typeof body.status === "string" && KNOWN_STATUSES.has(body.status)) {
        setState(body as ObjectsState);
      } else {
        setState({ status: "error" });
      }
    } catch {
      setState({ status: "error" });
    }
  }

  useEffect(() => {
    // load() only setState()s after an await, so there is no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset to the loading state, then re-fetch (used by the retry button).
  function retry() {
    setState(null);
    void load();
  }

  function toggleBuilding(id: number) {
    setCollapsedBuildings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleBlock(key: string) {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Loading
  if (state === null) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading objects">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-48 rounded-md" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  // Any non-"ok" state → single guidance card
  if (state.status !== "ok") {
    return <StatusCard status={state.status} onRetry={retry} />;
  }

  const { partner, complexType, buildings } = state;

  return (
    <div className="space-y-4">
      {/* Header: partner + complex type */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Boxes className="size-5 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">{partner}</h2>
            <p className="text-xs text-muted-foreground">
              {buildings.length} {buildings.length === 1 ? "building" : "buildings"}
            </p>
          </div>
        </div>
        <ComplexTypeBadge type={complexType} />
      </div>

      {buildings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <Building2 className="size-8 opacity-40 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No buildings</p>
            <p className="text-sm text-muted-foreground max-w-md">
              This partner hasn&apos;t reported any buildings yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        buildings.map((b) => {
          const open = !collapsedBuildings.has(b.id);
          const count = unitCount(b);
          const isEmpty =
            b.blocks.length === 0 &&
            b.parkings.length === 0 &&
            b.properties.length === 0 &&
            b.offices.length === 0;
          return (
            <Card key={b.id}>
              <button
                type="button"
                onClick={() => toggleBuilding(b.id)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 px-(--card-spacing) text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-t-xl"
              >
                <ChevronRight
                  className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                  aria-hidden="true"
                />
                <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 min-w-0 truncate font-semibold text-foreground">{b.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {count} {count === 1 ? "unit" : "units"}
                </span>
              </button>

              {open && (
                <CardContent className="space-y-4 pt-0">
                  {isEmpty ? (
                    <p className="py-2 text-sm text-muted-foreground">No objects in this building.</p>
                  ) : (
                    <>
                      {/* Blocks → apartments (nested, collapsible) */}
                      {b.blocks.map((blk) => {
                        const key = `${b.id}-${blk.id}`;
                        const blkOpen = !collapsedBlocks.has(key);
                        return (
                          <div key={blk.id} className="rounded-lg border border-border overflow-hidden">
                            <button
                              type="button"
                              onClick={() => toggleBlock(key)}
                              aria-expanded={blkOpen}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                            >
                              <ChevronRight
                                className={cn(
                                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                  blkOpen && "rotate-90"
                                )}
                                aria-hidden="true"
                              />
                              <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                              <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">
                                {blk.name}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                {blk.apartments.length}{" "}
                                {blk.apartments.length === 1 ? "apartment" : "apartments"}
                              </span>
                            </button>
                            {blkOpen && (
                              <div className="border-t border-border p-3">
                                {blk.apartments.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">No apartments in this block.</p>
                                ) : (
                                  <UnitTable units={blk.apartments} numberLabel="Apartment" />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Flat lists directly under the building */}
                      <FlatSection title="Parking" Icon={Car} units={b.parkings} numberLabel="Parking" />
                      <FlatSection
                        title="Properties"
                        Icon={Store}
                        units={b.properties}
                        numberLabel="Property"
                        showType
                      />
                      <FlatSection title="Offices" Icon={Briefcase} units={b.offices} numberLabel="Office" />
                    </>
                  )}
                </CardContent>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
