"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type EntryType = "COLLECTED" | "TRANSFER";
type EntryMethod = "CASH" | "BANK_TRANSFER" | "MANUAL";
type AccountOption = { id: string; name: string };

const TYPE_LABELS: Record<string, string> = { COLLECTED: "Collected", TRANSFER: "Transfer" };
const METHOD_LABELS: Record<string, string> = { CASH: "Cash", BANK_TRANSFER: "Bank account", MANUAL: "Manual" };

export function AddSettlementEntry({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [type, setType] = useState<EntryType>("COLLECTED");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<EntryMethod>("CASH");
  const [occurredAt, setOccurredAt] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const accountItems = Object.fromEntries(accounts.map((a) => [a.id, a.name]));

  function reset() {
    setAccountId(accounts[0]?.id ?? "");
    setType("COLLECTED");
    setAmount("");
    setMethod("CASH");
    setOccurredAt("");
    setNote("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) {
      toast.error("Select a partner account.");
      return;
    }
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
      reset();
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to add entry. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm"><Plus className="h-4 w-4 mr-1.5" />Add entry</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add settlement entry</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} id="settlement-entry-form" className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="se-account">
              Partner account <span className="text-destructive">*</span>
            </Label>
            <Select items={accountItems} value={accountId} onValueChange={(v) => { if (v) setAccountId(v); }}>
              <SelectTrigger id="se-account">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select items={TYPE_LABELS} value={type} onValueChange={(v) => { if (v) setType(v as EntryType); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="COLLECTED">Collected</SelectItem>
                  <SelectItem value="TRANSFER">Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="se-amount">Amount <span className="text-destructive">*</span></Label>
              <Input
                id="se-amount"
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
            <Select items={METHOD_LABELS} value={method} onValueChange={(v) => { if (v) setMethod(v as EntryMethod); }}>
              <SelectTrigger>
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
              <Label htmlFor="se-date">Date</Label>
              <Input
                id="se-date"
                type="date"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="se-note">Note</Label>
              <Input
                id="se-note"
                placeholder="Optional note…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        </form>
        <DialogFooter className="pt-2">
          <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="settlement-entry-form" disabled={saving || !accountId}>
            {saving ? "Adding…" : "Add entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
