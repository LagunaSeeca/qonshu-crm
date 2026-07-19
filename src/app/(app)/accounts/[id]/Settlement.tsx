"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Landmark, ArrowDownCircle, ArrowUpCircle, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

type EntryType = "COLLECTED" | "TRANSFER";
type EntryMethod = "CASH" | "BANK_TRANSFER" | "MANUAL";

type Entry = {
  id: string;
  type: EntryType;
  amount: number;
  method: EntryMethod | null;
  occurredAt: string;
  note: string | null;
  createdById: string;
};

type MethodBreakdown = { CASH: number; BANK_TRANSFER: number; MANUAL: number };

type SettlementData = {
  collected: number;
  transferred: number;
  owed: number;
  collectedByMethod: MethodBreakdown;
  transferredByMethod: MethodBreakdown;
  entries: Entry[];
};

type Props = {
  accountId: string;
  isAdmin?: boolean;
  initialData?: SettlementData;
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const TYPE_LABELS: Record<string, string> = { COLLECTED: "Collected", TRANSFER: "Transfer" };
const METHOD_LABELS: Record<string, string> = { CASH: "Cash", BANK_TRANSFER: "Bank account", MANUAL: "Manual" };

function TypeBadge({ type }: { type: EntryType }) {
  if (type === "COLLECTED") {
    return (
      <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium">
        COLLECTED
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium">
      TRANSFER
    </Badge>
  );
}

export function Settlement({ accountId, isAdmin = false, initialData }: Props) {
  const router = useRouter();

  const [data, setData] = useState<SettlementData | null>(initialData ?? null);

  const [type, setType] = useState<EntryType>("COLLECTED");
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
          type,
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
      toast.success("Entry added.");
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

  const entries = data?.entries ?? [];

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
            <div className="text-xl font-bold tabular-nums">{money(data?.collected ?? 0)}</div>
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Cash</span>
                <span className="tabular-nums">{money(data?.collectedByMethod?.CASH ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Bank account</span>
                <span className="tabular-nums">{money(data?.collectedByMethod?.BANK_TRANSFER ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Manual</span>
                <span className="tabular-nums">{money(data?.collectedByMethod?.MANUAL ?? 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Transferred</CardTitle>
            <ArrowUpCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold tabular-nums">{money(data?.transferred ?? 0)}</div>
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Bank transfer</span>
                <span className="tabular-nums">{money(data?.transferredByMethod?.BANK_TRANSFER ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Cash</span>
                <span className="tabular-nums">{money(data?.transferredByMethod?.CASH ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Manual</span>
                <span className="tabular-nums">{money(data?.transferredByMethod?.MANUAL ?? 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Owed</CardTitle>
            <Landmark className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-foreground">{money(data?.owed ?? 0)}</div>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Add entry (admin only) */}
      {isAdmin && (
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">Add Entry</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleAddEntry} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select items={TYPE_LABELS} value={type} onValueChange={(val) => { if (val) setType(val as EntryType); }}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="COLLECTED">Collected</SelectItem>
                      <SelectItem value="TRANSFER">Transfer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
                {saving ? "Adding…" : "Add entry"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Registry */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-base font-semibold">Registry</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {!data ? (
            <Skeleton className="h-32 rounded-lg" aria-busy="true" aria-label="Loading registry" />
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Landmark className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No settlement entries yet</p>
            </div>
          ) : (
              <div className="rounded-lg border border-border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="font-semibold text-foreground">Date</TableHead>
                      <TableHead className="font-semibold text-foreground">Type</TableHead>
                      <TableHead className="font-semibold text-foreground">Method</TableHead>
                      <TableHead className="text-right font-semibold text-foreground">Amount</TableHead>
                      <TableHead className="font-semibold text-foreground">Note</TableHead>
                      {isAdmin && <TableHead className="w-10" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="text-muted-foreground">
                          {new Date(entry.occurredAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <TypeBadge type={entry.type} />
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
                        <TableCell className="text-right tabular-nums font-medium">{money(entry.amount)}</TableCell>
                        <TableCell className="text-foreground">{entry.note ?? "—"}</TableCell>
                        {isAdmin && (
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
