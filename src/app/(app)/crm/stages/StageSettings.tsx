"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Trash2, Pencil, Check, X, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StageType = "OPEN" | "WON" | "LOST";

type Stage = {
  id: string;
  name: string;
  type: StageType;
  probability: number;
  order: number;
};

type Props = {
  initialStages: Stage[];
  shareAllLeads: boolean;
};

const STAGE_TYPES: StageType[] = ["OPEN", "WON", "LOST"];
const STAGE_TYPE_LABELS: Record<string, string> = { OPEN: "Open", WON: "Won", LOST: "Lost" };

function StageBadge({ type }: { type: StageType }) {
  switch (type) {
    case "WON":
      return <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 text-xs">{type}</Badge>;
    case "LOST":
      return <Badge variant="destructive" className="text-xs">{type}</Badge>;
    default:
      return <Badge variant="outline" className="text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950 text-xs">{type}</Badge>;
  }
}

export function StageSettings({ initialStages, shareAllLeads: initialShare }: Props) {
  const router = useRouter();
  const [stages, setStages] = useState<Stage[]>(initialStages);
  const [shareAll, setShareAll] = useState(initialShare);

  // Inline edit state
  const [editing, setEditing] = useState<Record<string, Partial<Stage>>>({});

  function startEdit(stage: Stage) {
    setEditing((prev) => ({ ...prev, [stage.id]: { name: stage.name, type: stage.type, probability: stage.probability } }));
  }

  function cancelEdit(id: string) {
    setEditing((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function saveEdit(stage: Stage) {
    const patch = editing[stage.id];
    if (!patch) return;
    const res = await fetch(`/api/stages/${stage.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      cancelEdit(stage.id);
      toast.success("Stage saved.");
      router.refresh();
    } else {
      toast.error("Failed to save stage. Please try again.");
    }
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/stages/${id}`, { method: "DELETE" });
    if (res.status === 409) {
      toast.error("Move its leads first before deleting this stage.");
    } else if (res.ok) {
      setStages((prev) => prev.filter((s) => s.id !== id));
      toast.success("Stage deleted.");
      router.refresh();
    } else {
      toast.error("Failed to delete stage. Please try again.");
    }
  }

  async function handleReorder(id: string, direction: "up" | "down") {
    const idx = stages.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const next = [...stages];
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setStages(next);
    const res = await fetch("/api/stages/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedIds: next.map((s) => s.id) }),
    });
    if (!res.ok) {
      toast.error("Failed to reorder stages. Please try again.");
      setStages(stages);
      return;
    }
    router.refresh();
  }

  // Add stage
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<StageType>("OPEN");
  const [newProb, setNewProb] = useState(0);
  const [adding, setAdding] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    const res = await fetch("/api/stages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName, type: newType, probability: newProb }),
    });
    setAdding(false);
    if (!res.ok) {
      toast.error("Failed to add stage. Please try again.");
      return;
    }
    const created = await res.json() as Stage;
    setStages((prev) => [...prev, created]);
    setNewName("");
    setNewProb(0);
    toast.success("Stage added.");
    router.refresh();
  }

  async function handleShareToggle(checked: boolean) {
    setShareAll(checked);
    const res = await fetch("/api/company/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shareAllLeads: checked }),
    });
    if (!res.ok) {
      setShareAll(!checked);
      toast.error("Failed to update setting. Please try again.");
      return;
    }
    toast.success(checked ? "Leads shared with everyone." : "Lead sharing restricted.");
    router.refresh();
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-foreground">Stage Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your pipeline stages and visibility.</p>
      </div>

      {/* Visibility toggle */}
      <Card>
        <CardHeader>
          <CardTitle>Lead Visibility</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p id="share-all-leads-label" className="text-sm font-medium text-foreground">
                Share all leads with everyone
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                When on, all team members can view every lead regardless of owner.
              </p>
            </div>
            <Switch
              aria-labelledby="share-all-leads-label"
              checked={shareAll}
              onCheckedChange={handleShareToggle}
            />
          </div>
        </CardContent>
      </Card>

      {/* Pipeline stages card */}
      <Card>
        <CardHeader>
          <CardTitle>Pipeline Stages</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {stages.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No stages yet — add one below.</p>
          ) : (
            <div className="divide-y divide-border">
              {stages.map((stage, idx) => {
                const ed = editing[stage.id];
                return (
                  <div key={stage.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    {/* Order number */}
                    <span className="w-5 text-xs text-muted-foreground tabular-nums shrink-0 text-center">{idx + 1}</span>

                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      {ed ? (
                        <Input
                          value={ed.name ?? stage.name}
                          onChange={(e) => setEditing((prev) => ({ ...prev, [stage.id]: { ...prev[stage.id], name: e.target.value } }))}
                          className="h-7 text-sm w-36"
                          aria-label="Stage name"
                        />
                      ) : (
                        <span className="text-sm font-medium text-foreground">{stage.name}</span>
                      )}
                    </div>

                    {/* Type */}
                    <div className="w-28 shrink-0">
                      {ed ? (
                        <Select
                          items={STAGE_TYPE_LABELS}
                          value={ed.type ?? stage.type}
                          onValueChange={(v) => {
                            if (v) setEditing((prev) => ({ ...prev, [stage.id]: { ...prev[stage.id], type: v as StageType } }));
                          }}
                        >
                          <SelectTrigger className="h-7 text-xs w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STAGE_TYPES.map((t) => (
                              <SelectItem key={t} value={t}>{STAGE_TYPE_LABELS[t]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <StageBadge type={stage.type} />
                      )}
                    </div>

                    {/* Probability */}
                    <div className="w-20 shrink-0 text-sm text-center">
                      {ed ? (
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={ed.probability ?? stage.probability}
                          onChange={(e) => setEditing((prev) => ({ ...prev, [stage.id]: { ...prev[stage.id], probability: Number(e.target.value) } }))}
                          className="h-7 text-xs text-center w-full tabular-nums"
                          aria-label="Probability"
                        />
                      ) : (
                        <span className="tabular-nums text-muted-foreground">{stage.probability}%</span>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => handleReorder(stage.id, "up")}
                        disabled={idx === 0}
                        aria-label="Move stage up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => handleReorder(stage.id, "down")}
                        disabled={idx === stages.length - 1}
                        aria-label="Move stage down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>

                      {ed ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
                            onClick={() => saveEdit(stage)}
                            aria-label="Save stage"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => cancelEdit(stage.id)}
                            aria-label="Cancel edit"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => startEdit(stage)}
                          aria-label="Edit stage"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(stage.id)}
                        aria-label="Delete stage"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add stage card */}
      <Card>
        <CardHeader>
          <CardTitle>Add Stage</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1.5">
              <Label htmlFor="new-stage-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="new-stage-name"
                className="w-40"
                placeholder="Stage name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-stage-type">Type</Label>
              <Select items={STAGE_TYPE_LABELS} value={newType} onValueChange={(v) => { if (v) setNewType(v as StageType); }}>
                <SelectTrigger id="new-stage-type" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAGE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{STAGE_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-stage-prob">Probability %</Label>
              <Input
                id="new-stage-prob"
                type="number"
                min={0}
                max={100}
                className="w-24 tabular-nums"
                value={newProb}
                onChange={(e) => setNewProb(Number(e.target.value))}
              />
            </div>
            <Button type="submit" disabled={adding} className="shrink-0">
              <Plus className="h-4 w-4 mr-1.5" />
              {adding ? "Adding…" : "Add Stage"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
