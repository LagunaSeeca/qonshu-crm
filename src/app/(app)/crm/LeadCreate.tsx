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
import { OwnerSelectItems } from "@/components/OwnerSelectItems";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Stage = { id: string; name: string };
type Owner = { id: string; name: string; teamId: string | null; teamName: string | null };

const PRIORITY_LABELS: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

type Props = {
  /** The pipeline to pick a stage from (the viewer's own team). Ignored for the owner, who uses `stagesByTeam`. */
  stages: Stage[];
  /** SUPER_ADMIN only: every team's pipeline, so the stage picker can follow the chosen owner's team. */
  stagesByTeam?: Record<string, Stage[]>;
  /** People the viewer may assign to (listAssignableUsers). Unused for a MEMBER, who owns what they create. */
  owners?: Owner[];
  currentUserId: string;
  role: string;
};

export function LeadCreate({ stages, stagesByTeam, owners = [], currentUserId, role }: Props) {
  const router = useRouter();
  const isSuper = role === "SUPER_ADMIN";
  // A member always owns what they create — no picker at all (the server ignores a supplied owner).
  const showOwnerPicker = role !== "MEMBER";
  // Default to the CURRENT user, never owners[0]: that is usually the admin, and under owner-only
  // visibility a member's own new lead would vanish from their view. The owner has no default.
  const defaultOwner = isSuper ? "" : currentUserId;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [buildingName, setBuildingName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [stageChoice, setStageChoice] = useState("");
  const [ownerId, setOwnerId] = useState(defaultOwner);
  const [priority, setPriority] = useState("MEDIUM");
  const [loading, setLoading] = useState(false);

  const ownerTeamId = owners.find((o) => o.id === ownerId)?.teamId ?? null;
  const stageList: Stage[] = isSuper ? (ownerTeamId ? (stagesByTeam?.[ownerTeamId] ?? []) : []) : stages;
  // The chosen stage only counts while it is still in the list (the owner changing team swaps the list).
  const stageId = stageList.some((s) => s.id === stageChoice) ? stageChoice : (stageList[0]?.id ?? "");

  const ownerItems = Object.fromEntries(owners.map((m) => [m.id, m.name]));
  const stageItems = Object.fromEntries(stageList.map((s) => [s.id, s.name]));

  function reset() {
    setTitle("");
    setBuildingName("");
    setContactName("");
    setPhone("");
    setStageChoice("");
    setOwnerId(defaultOwner);
    setPriority("MEDIUM");
  }

  const needsOwner = showOwnerPicker && !ownerId;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (needsOwner) {
      toast.error("Choose who owns this lead");
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          // The building name is the building's identity (what a lead claims, and what the partner
          // match runs on), which is why it is posted as `companyName`.
          companyName: buildingName,
          contactName,
          phone: phone || undefined,
          stageId,
          ownerId: showOwnerPicker ? ownerId : undefined,
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
        // 409 building_claimed: someone else already registered this building. The server's
        // message names who; show it verbatim and keep the dialog open so the name can be fixed.
        if (r.status === 409 && body?.message) toast.error(body.message);
        else toast.error(body?.error ?? "Failed to create lead");
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
            <Label htmlFor="lc-building">
              Building name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="lc-building"
              placeholder="Residential complex / building"
              value={buildingName}
              onChange={(e) => setBuildingName(e.target.value)}
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
          {showOwnerPicker && (
            <div className="space-y-1.5">
              <Label htmlFor="lc-owner">
                Person in charge {isSuper && <span className="text-destructive">*</span>}
              </Label>
              <Select items={ownerItems} value={ownerId} onValueChange={(v) => { if (v !== null) setOwnerId(v); }}>
                <SelectTrigger id="lc-owner">
                  <SelectValue placeholder={isSuper ? "Choose an owner" : "Assign to me"} />
                </SelectTrigger>
                <SelectContent>
                  <OwnerSelectItems owners={owners} grouped={isSuper} />
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="lc-stage">Stage</Label>
              <Select items={stageItems} value={stageId} onValueChange={(v) => { if (v !== null) setStageChoice(v); }}>
                <SelectTrigger id="lc-stage">
                  <SelectValue placeholder={isSuper && !ownerId ? "Choose an owner first" : "Select stage"} />
                </SelectTrigger>
                <SelectContent>
                  {stageList.map((s) => (
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
          <Button type="submit" form="lead-create-form" disabled={loading || !stageId}>
            {loading ? "Creating…" : "Create lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
