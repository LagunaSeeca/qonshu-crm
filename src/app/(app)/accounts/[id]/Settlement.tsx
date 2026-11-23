"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Landmark, ArrowDownCircle, ArrowUpCircle, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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
import { formatMoney } from "@/lib/money";
import type { AccountSettlement, SettlementStatus } from "@/lib/tenant/settlements";

type EntryMethod = "CASH" | "BANK_TRANSFER" | "MANUAL";

// The JSON wire shape of GET /api/accounts/[id]/settlement: AccountSettlement after
// serialization. Dates become ISO strings and Prisma Decimals become strings, so the
// transfer rows are re-typed here; everything else is derived from the service type so
// drift is a compile error.
type SettlementTransfer = {
  id: string;
  amount: string | number;
  method: EntryMethod;
  occurredAt: string;
  note: string | null;
};
type SettlementData = Omit<AccountSettlement, "period" | "transfers" | "owed"> & {
  transfers: SettlementTransfer[];
};

type Props = {
  accountId: string;
  /** Whether the viewer holds `write_settlements` (add/edit/delete entries). */
  canWrite?: boolean;
  initialData?: SettlementData;
};

const METHOD_LABELS: Record<string, string> = { CASH: "Cash", BANK_TRANSFER: "Bank account", MANUAL: "Manual" };

const STATUS_NOTE: Record<Exclude<SettlementStatus, "ok">, string> = {
  "not-configured": "Not connected to the partner API",
  "invalid-key": "Partner API key rejected",
  "unknown-partner": "Partner not recognized",
  unavailable: "Partner API unavailable",
};

export function Settlement({ accountId, canWrite = false, initialData }: Props) {
  const router = useRouter();

  const [data, setData] = useState<SettlementData | null>(initialData ?? null);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<EntryMethod>("CASH");
  const [occurredAt, setOccurredAt] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/accounts/${accountId}/settlement`);
      if (!res.ok) {
        toast.error("Failed to load settlement.");
        return;
      }
      setData(await res.json());
    } catch {
      toast.error("Failed to load settlement.");
    }
  }

  useEffect(() => {
    if (initialData) return; // seeded for a deterministic first render (SSR/testing) — no auto-fetch
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAddEntry(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/settlement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amount: Number(amount),
          method,
          occurredAt: occurredAt || new Date().toISOString(),
          note: note || undefined,
        }),
      });
      if (!res.ok) {
        toast.error("Failed to add entry. Please try again.");
        return;
      }
      toast.success("Transfer added.");
      setAmount("");
      setOccurredAt("");
      setNote("");
      await load();
      router.refresh();
    } catch {
      toast.error("Failed to add entry. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entryId: string) {
    setDeletingId(entryId);
    try {
      const res = await fetch(`/api/accounts/${accountId}/settlement/${entryId}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Failed to delete entry. Please try again.");
        return;
      }
      toast.success("Entry deleted.");
      await load();
      router.refresh();
    } catch {
      toast.error("Failed to delete entry. Please try again.");
    } finally {
      setDeletingId(null);
    }
  }

  const transfers = data?.transfers ?? [];

  return (
    <div className="space-y-6">
      {/* Balance tiles */}
      {!data ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-busy="true" aria-label="Loading settlement">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Collected</CardTitle>
            <ArrowDownCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {/* The service OMITS collected/remaining when status !== "ok" (upstream unknown); a 0
                there would read as "collected nothing". Show the status instead. There is
                no by-method split: Collected is the live card total only. */}
            {data.collected !== undefined ? (
              <div className="text-xl font-bold tabular-nums">{formatMoney(data.collected)}</div>
            ) : (
              <div className="text-sm text-muted-foreground">{STATUS_NOTE[data.status === "ok" ? "unavailable" : data.status]}</div>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Transferred</CardTitle>
            <ArrowUpCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{formatMoney(data.transferred)}</div>
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Bank transfer</span>
                <span className="tabular-nums">{formatMoney(data.transferredByMethod.BANK_TRANSFER)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Cash</span>
                <span className="tabular-nums">{formatMoney(data.transferredByMethod.CASH)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Manual</span>
                <span className="tabular-nums">{formatMoney(data.transferredByMethod.MANUAL)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Remaining</CardTitle>
            <Landmark className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {data.remaining !== undefined ? (
              <div className="text-2xl font-bold tabular-nums text-foreground">{formatMoney(data.remaining)}</div>
            ) : (
              <div className="text-sm text-muted-foreground">Unavailable until Collected can be read</div>
            )}
          </CardContent>
        </Card>
      </div>
      )}

      {/* Add entry (admin only) */}
      {canWrite && (
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">Add Transfer</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleAddEntry} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="settlementAmount">Amount <span className="text-destructive">*</span></Label>
                  <Input
                    id="settlementAmount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="tabular-nums"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>
                  Method <span className="text-destructive">*</span>
                </Label>
                <Select items={METHOD_LABELS} value={method} onValueChange={(val) => { if (val) setMethod(val as EntryMethod); }}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CASH">Cash</SelectItem>
                    <SelectItem value="BANK_TRANSFER">Bank account</SelectItem>
                    <SelectItem value="MANUAL">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="settlementDate">Date</Label>
                  <Input
                    id="settlementDate"
                    type="date"
                    value={occurredAt}
                    onChange={(e) => setOccurredAt(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settlementNote">Note</Label>
                  <Input
                    id="settlementNote"
                    placeholder="Optional note…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </div>

              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Adding…" : "Add transfer"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Registry */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold">Transfers</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {!data ? (
            <Skeleton className="h-32 rounded-lg" aria-busy="true" aria-label="Loading registry" />
          ) : transfers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Landmark className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No transfers recorded for this period</p>
            </div>
          ) : (
              <div className="rounded-lg border border-border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="font-semibold text-foreground">Date</TableHead>
                      <TableHead className="font-semibold text-foreground">Method</TableHead>
                      <TableHead className="text-right font-semibold text-foreground">Amount</TableHead>
                      <TableHead className="font-semibold text-foreground">Note</TableHead>
                      {canWrite && <TableHead className="w-10" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transfers.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="text-muted-foreground">
                          {new Date(entry.occurredAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {entry.method === "BANK_TRANSFER"
                            ? "Bank account"
                            : entry.method === "CASH"
                              ? "Cash"
                              : entry.method === "MANUAL"
                                ? "Manual"
                                : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{formatMoney(Number(entry.amount))}</TableCell>
                        <TableCell className="text-foreground">{entry.note ?? "—"}</TableCell>
                        {canWrite && (
                          <TableCell>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label="Delete entry"
                              disabled={deletingId === entry.id}
                              onClick={() => handleDelete(entry.id)}
                              className="size-7 text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TableCell>
                        )}
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
