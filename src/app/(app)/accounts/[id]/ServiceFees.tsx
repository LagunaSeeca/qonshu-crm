"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ReceiptText, CheckCircle2, Circle, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/money";

type FeeStatus = "UNPAID" | "PAID";
type FeeMethod = "CASH" | "BANK_TRANSFER" | "MANUAL";

type Fee = {
  id: string;
  periodMonth: string;
  amount: number;
  dueDate: string | null;
  status: FeeStatus;
  paidAt: string | null;
  method: FeeMethod | null;
  note: string | null;
};

type FeesData = {
  fees: Fee[];
  totalBilled: number;
  totalPaid: number;
  totalOutstanding: number;
};

type Props = {
  accountId: string;
  isAdmin?: boolean;
  /** `write_settlements` (SUPER_ADMIN): may set the monthly rate and create fees. Pricing is owner-only. */
  canPrice?: boolean;
  /** The building's current rate as an exact string ("1234.50"), or null when none is agreed. */
  initialRate?: string | null;
  initialData?: FeesData;
};

const METHOD_LABELS: Record<string, string> = { CASH: "Cash", BANK_TRANSFER: "Bank account", MANUAL: "Manual" };

function monthLabel(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function StatusBadge({ status }: { status: FeeStatus }) {
  if (status === "PAID") {
    return (
      <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium">
        PAID
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium">
      UNPAID
    </Badge>
  );
}

export function ServiceFees({ accountId, isAdmin = false, canPrice = false, initialRate = null, initialData }: Props) {
  const router = useRouter();

  const [data, setData] = useState<FeesData | null>(initialData ?? null);

  const [periodMonth, setPeriodMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The rate stays a STRING end to end ("1234.50"); it is never passed through Number() to be sent.
  const [rate, setRate] = useState<string | null>(initialRate);
  const [rateDraft, setRateDraft] = useState(initialRate ?? "");
  const [rateSaving, setRateSaving] = useState(false);

  async function load() {
    try {
      const res = await fetch(`/api/accounts/${accountId}/service-fees`);
      if (!res.ok) {
        toast.error("Failed to load service fees.");
        return;
      }
      setData(await res.json());
    } catch {
      toast.error("Failed to load service fees.");
    }
  }

  useEffect(() => {
    if (initialData) return; // seeded for a deterministic first render (SSR/testing) — no auto-fetch
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveRate(next: string | null) {
    setRateSaving(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/service-fee-rate`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ monthlyServiceFee: next }),
      });
      if (res.status === 403) {
        toast.error("Only the owner (super admin) can set what a building is billed. Recording a payment is still allowed.");
        return;
      }
      if (res.status === 400) {
        toast.error("Enter a positive amount with at most 2 decimals, e.g. 120 or 120.50.");
        return;
      }
      if (!res.ok) {
        toast.error("Failed to save the monthly rate. Please try again.");
        return;
      }
      const saved = (await res.json()) as { monthlyServiceFee: string | null };
      setRate(saved.monthlyServiceFee);
      setRateDraft(saved.monthlyServiceFee ?? "");
      toast.success(saved.monthlyServiceFee ? "Monthly rate saved." : "Monthly rate cleared.");
      router.refresh();
    } catch {
      toast.error("Failed to save the monthly rate. Please try again.");
    } finally {
      setRateSaving(false);
    }
  }

  async function handleAddFee(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/service-fees`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          periodMonth: periodMonth ? `${periodMonth}-01` : undefined,
          // Sent as the typed string, NOT Number(amount): the route validates it with
          // FeeAmountSchema and it lands in a Prisma Decimal column. Converting here would
          // round-trip the amount through a float for no reason.
          amount: amount.trim(),
          dueDate: dueDate || undefined,
          note: note || undefined,
        }),
      });
      if (!res.ok) {
        if (res.status === 409) toast.error("A fee already exists for that account and month.");
        else toast.error("Failed to add fee. Please try again.");
        return;
      }
      toast.success("Service fee added.");
      setPeriodMonth("");
      setAmount("");
      setDueDate("");
      setNote("");
      await load();
      router.refresh();
    } catch {
      toast.error("Failed to add fee. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkPaid(feeId: string) {
    setBusyId(feeId);
    try {
      const res = await fetch(`/api/accounts/${accountId}/service-fees/${feeId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "markPaid" }),
      });
      if (!res.ok) {
        toast.error("Failed to mark fee as paid. Please try again.");
        return;
      }
      toast.success("Marked as paid.");
      await load();
      router.refresh();
    } catch {
      toast.error("Failed to mark fee as paid. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleMarkUnpaid(feeId: string) {
    setBusyId(feeId);
    try {
      const res = await fetch(`/api/accounts/${accountId}/service-fees/${feeId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "markUnpaid" }),
      });
      if (!res.ok) {
        toast.error("Failed to mark fee as unpaid. Please try again.");
        return;
      }
      toast.success("Marked as unpaid.");
      await load();
      router.refresh();
    } catch {
      toast.error("Failed to mark fee as unpaid. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(feeId: string) {
    setBusyId(feeId);
    try {
      const res = await fetch(`/api/accounts/${accountId}/service-fees/${feeId}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Failed to delete fee. Please try again.");
        return;
      }
      toast.success("Fee deleted.");
      await load();
      router.refresh();
    } catch {
      toast.error("Failed to delete fee. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  const fees = data?.fees ?? [];

  return (
    <div className="space-y-6">
      {/* Totals tiles */}
      {!data ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-busy="true" aria-label="Loading service fees">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Billed</CardTitle>
            <ReceiptText className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{formatMoney(data?.totalBilled ?? 0)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Paid</CardTitle>
            <CheckCircle2 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{formatMoney(data?.totalPaid ?? 0)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Outstanding</CardTitle>
            <Circle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-foreground">{formatMoney(data?.totalOutstanding ?? 0)}</div>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Monthly rate (owner only) */}
      {canPrice && (
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">Monthly service fee</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              {rate === null
                ? "No rate set. This building is not billed automatically."
                : `Currently ${formatMoney(Number(rate), { decimals: 2 })} per month.`}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = rateDraft.trim();
                if (v) void saveRate(v);
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="monthlyRate">Rate per month</Label>
                <Input
                  id="monthlyRate"
                  type="text"
                  inputMode="decimal"
                  placeholder="e.g. 120.50"
                  value={rateDraft}
                  onChange={(e) => setRateDraft(e.target.value)}
                  className="w-40 tabular-nums"
                />
              </div>
              <Button type="submit" size="sm" disabled={rateSaving || !rateDraft.trim() || rateDraft.trim() === rate}>
                {rateSaving ? "Saving…" : "Save rate"}
              </Button>
              {rate !== null && (
                <Button type="button" size="sm" variant="outline" disabled={rateSaving} onClick={() => void saveRate(null)}>
                  Clear rate
                </Button>
              )}
            </form>
            <p className="text-xs text-muted-foreground">
              Changing the rate affects future months only. Fees already generated keep their amount.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Add fee (owner only: creating a fee sets an amount) */}
      {canPrice && (
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">Add Service Fee</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleAddFee} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="feeMonth">Month <span className="text-destructive">*</span></Label>
                  <Input
                    id="feeMonth"
                    type="month"
                    value={periodMonth}
                    onChange={(e) => setPeriodMonth(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="feeAmount">Amount <span className="text-destructive">*</span></Label>
                  <Input
                    id="feeAmount"
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

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="feeDue">Due date</Label>
                  <Input
                    id="feeDue"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="feeNote">Note</Label>
                  <Input
                    id="feeNote"
                    placeholder="Optional note…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </div>

              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Adding…" : "Add fee"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Fee table */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold">Fees</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {!data ? (
            <Skeleton className="h-32 rounded-lg" aria-busy="true" aria-label="Loading fees" />
          ) : fees.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <ReceiptText className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No service fees yet</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="font-semibold text-foreground">Period</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Amount</TableHead>
                    <TableHead className="font-semibold text-foreground">Due date</TableHead>
                    <TableHead className="font-semibold text-foreground">Status</TableHead>
                    <TableHead className="font-semibold text-foreground">Method</TableHead>
                    <TableHead className="font-semibold text-foreground">Note</TableHead>
                    {isAdmin && <TableHead className="w-40" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fees.map((fee) => (
                    <TableRow key={fee.id}>
                      <TableCell className="text-foreground font-medium">{monthLabel(fee.periodMonth)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatMoney(fee.amount)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {fee.dueDate ? new Date(fee.dueDate).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={fee.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {fee.method ? METHOD_LABELS[fee.method] : "—"}
                      </TableCell>
                      <TableCell className="text-foreground">{fee.note ?? "—"}</TableCell>
                      {isAdmin && (
                        <TableCell>
                          <div className="flex items-center gap-1 justify-end">
                            {fee.status === "UNPAID" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busyId === fee.id}
                                onClick={() => handleMarkPaid(fee.id)}
                                className="h-6 px-2 text-xs"
                              >
                                Mark paid
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busyId === fee.id}
                                onClick={() => handleMarkUnpaid(fee.id)}
                                className="h-6 px-2 text-xs"
                              >
                                Mark unpaid
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label="Delete fee"
                              disabled={busyId === fee.id}
                              onClick={() => handleDelete(fee.id)}
                              className="size-7 text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
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
