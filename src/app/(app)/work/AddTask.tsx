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

type LeadOption = { id: string; title: string };
type AccountOption = { id: string; name: string };
type Member = { id: string; name: string | null; email: string };

type ParentRef = { key: string; type: "LEAD" | "ACCOUNT"; id: string; label: string };

export function AddTask({
  leads,
  accounts,
  members,
}: {
  leads: LeadOption[];
  accounts: AccountOption[];
  members: Member[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const refs: ParentRef[] = [
    ...leads.map((l) => ({ key: `LEAD:${l.id}`, type: "LEAD" as const, id: l.id, label: `Lead — ${l.title}` })),
    ...accounts.map((a) => ({ key: `ACCOUNT:${a.id}`, type: "ACCOUNT" as const, id: a.id, label: `Account — ${a.name}` })),
  ];
  const refItems = Object.fromEntries(refs.map((r) => [r.key, r.label]));
  const memberItems = Object.fromEntries(members.map((m) => [m.id, m.name ?? m.email]));

  const [attachTo, setAttachTo] = useState(refs[0]?.key ?? "");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setAttachTo(refs[0]?.key ?? "");
    setTitle("");
    setDueDate("");
    setAssigneeId("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ref = refs.find((r) => r.key === attachTo);
    if (!ref) {
      toast.error("Select a lead or account to attach the task to.");
      return;
    }
    setSaving(true);
    try {
      const endpoint = ref.type === "LEAD" ? `/api/leads/${ref.id}/tasks` : `/api/accounts/${ref.id}/tasks`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
          assigneeId: assigneeId || undefined,
        }),
      });
      if (!res.ok) {
        toast.error("Failed to add task. Please try again.");
        return;
      }
      toast.success("Task added.");
      reset();
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to add task. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm"><Plus className="h-4 w-4 mr-1.5" />Add task</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} id="work-add-task-form" className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="at-attach">
              Attach to <span className="text-destructive">*</span>
            </Label>
            <Select items={refItems} value={attachTo} onValueChange={(v) => { if (v) setAttachTo(v); }}>
              <SelectTrigger id="at-attach">
                <SelectValue placeholder="Select a lead or account" />
              </SelectTrigger>
              <SelectContent>
                {refs.map((r) => (
                  <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="at-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="at-title"
              placeholder="Task title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="at-due">Due date</Label>
              <Input
                id="at-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="at-assignee">Assignee</Label>
              <Select items={memberItems} value={assigneeId} onValueChange={(v) => { setAssigneeId(v ?? ""); }}>
                <SelectTrigger id="at-assignee">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name ?? m.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </form>
        <DialogFooter className="pt-2">
          <Button variant="outline" type="button" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="work-add-task-form" disabled={saving || !attachTo}>
            {saving ? "Adding…" : "Add task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
