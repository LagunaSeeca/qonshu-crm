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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
  initialData?: FeesData;
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

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

export function ServiceFees({ accountId, isAdmin = false, initialData }: Props) {
  const router = useRouter();

  const [data, setData] = useState<FeesData | null>(initialData ?? null);

  const [periodMonth, setPeriodMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  async function handleAddFee(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/service-fees`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          periodMonth: periodMonth ? `${periodMonth}-01` : undefined,
          amount: Number(amount),
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Billed</CardTitle>
            <ReceiptText className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(data?.totalBilled ?? 0)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Paid</CardTitle>
            <CheckCircle2 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(data?.totalPaid ?? 0)}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Outstanding</CardTitle>
            <Circle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-foreground">{money(data?.totalOutstanding ?? 0)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Add fee (admin only) */}
      {isAdmin && (
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
          {fees.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <ReceiptText className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No service fees yet</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
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
                      <TableCell className="text-right tabular-nums font-medium">{money(fee.amount)}</TableCell>
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
