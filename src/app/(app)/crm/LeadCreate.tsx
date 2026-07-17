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

type Stage = { id: string; name: string };
type Member = { id: string; name: string };

const PRIORITY_LABELS: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

export function LeadCreate({ stages, members = [] }: { stages: Stage[]; members?: Member[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [stageId, setStageId] = useState(stages[0]?.id ?? "");
  const [ownerId, setOwnerId] = useState(members[0]?.id ?? "");
  const [priority, setPriority] = useState("MEDIUM");
  const [loading, setLoading] = useState(false);

  const ownerItems = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const stageItems = Object.fromEntries(stages.map((s) => [s.id, s.name]));

  function reset() {
    setTitle("");
    setContactName("");
    setPhone("");
    setStageId(stages[0]?.id ?? "");
    setOwnerId(members[0]?.id ?? "");
    setPriority("MEDIUM");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          contactName,
          phone: phone || undefined,
          stageId,
          ownerId: ownerId || undefined,
          priority,
        }),
      });
      if (r.ok) {
        toast.success("Lead created");
        reset();
        setOpen(false);
        router.refresh();
      } else {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? "Failed to create lead");
      }
    } catch {
      toast.error("Failed to create lead");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm"><Plus className="h-4 w-4 mr-1.5" />New Lead</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create lead</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} id="lead-create-form" className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="lc-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="lc-title"
              placeholder="Deal title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lc-contact">
              Contact name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="lc-contact"
              placeholder="Contact name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lc-phone">Contact phone</Label>
            <Input
              id="lc-phone"
              type="tel"
              placeholder="Contact phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lc-owner">Person in charge</Label>
            <Select items={ownerItems} value={ownerId} onValueChange={(v) => { if (v !== null) setOwnerId(v); }}>
              <SelectTrigger id="lc-owner">
                <SelectValue placeholder="Assign to me" />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="lc-stage">Stage</Label>
              <Select items={stageItems} value={stageId} onValueChange={(v) => { if (v !== null) setStageId(v); }}>
                <SelectTrigger id="lc-stage">
                  <SelectValue placeholder="Select stage" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lc-priority">Priority</Label>
              <Select items={PRIORITY_LABELS} value={priority} onValueChange={(v) => { if (v !== null) setPriority(v); }}>
                <SelectTrigger id="lc-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Low</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HIGH">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </form>
        <DialogFooter className="pt-2">
          <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" form="lead-create-form" disabled={loading}>
            {loading ? "Creating…" : "Create lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
