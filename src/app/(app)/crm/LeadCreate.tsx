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

export function LeadCreate({ stages }: { stages: Stage[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [contactName, setContactName] = useState("");
  const [stageId, setStageId] = useState(stages[0]?.id ?? "");
  const [value, setValue] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [loading, setLoading] = useState(false);

  function reset() {
    setTitle("");
    setContactName("");
    setStageId(stages[0]?.id ?? "");
    setValue("");
    setPriority("MEDIUM");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, contactName, stageId, value: value ? Number(value) : undefined, priority }),
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="lc-stage">Stage</Label>
              <Select value={stageId} onValueChange={(v) => { if (v !== null) setStageId(v); }}>
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
              <Select value={priority} onValueChange={(v) => { if (v !== null) setPriority(v); }}>
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
          <div className="space-y-1.5">
            <Label htmlFor="lc-value">Value (USD)</Label>
            <Input
              id="lc-value"
              type="number"
              min={0}
              placeholder="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="tabular-nums"
            />
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
