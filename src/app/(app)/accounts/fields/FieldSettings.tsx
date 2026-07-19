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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type FieldType = "TEXT" | "NUMBER" | "CURRENCY" | "DATE";

type FieldDef = {
  id: string;
  label: string;
  type: FieldType;
  order: number;
};

type Props = {
  initialDefs: FieldDef[];
};

const FIELD_TYPES: FieldType[] = ["TEXT", "NUMBER", "CURRENCY", "DATE"];
const FIELD_TYPE_LABELS: Record<string, string> = { TEXT: "Text", NUMBER: "Number", CURRENCY: "Currency", DATE: "Date" };

export function FieldSettings({ initialDefs }: Props) {
  const router = useRouter();
  const [defs, setDefs] = useState<FieldDef[]>(initialDefs);

  // Inline edit state
  const [editing, setEditing] = useState<Record<string, Partial<FieldDef>>>({});

  function startEdit(def: FieldDef) {
    setEditing((prev) => ({ ...prev, [def.id]: { label: def.label, type: def.type } }));
  }

  function cancelEdit(id: string) {
    setEditing((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function saveEdit(def: FieldDef) {
    const patch = editing[def.id];
    if (!patch) return;
    const res = await fetch(`/api/account-fields/${def.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.status === 409) {
      toast.error("A field with that label already exists.");
    } else if (res.ok) {
      const updated = await res.json() as FieldDef;
      setDefs((prev) => prev.map((d) => (d.id === def.id ? { ...d, label: updated.label, type: updated.type } : d)));
      cancelEdit(def.id);
      toast.success("Field saved.");
      router.refresh();
    } else {
      toast.error("Failed to save field. Please try again.");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this field? All values stored for it will be removed.")) return;
    const res = await fetch(`/api/account-fields/${id}`, { method: "DELETE" });
    if (res.ok) {
      setDefs((prev) => prev.filter((d) => d.id !== id));
      toast.success("Field deleted.");
      router.refresh();
    } else {
      toast.error("Failed to delete field. Please try again.");
    }
  }

  async function handleReorder(id: string, direction: "up" | "down") {
    const idx = defs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const next = [...defs];
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setDefs(next);
    const res = await fetch("/api/account-fields/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedIds: next.map((d) => d.id) }),
    });
    if (!res.ok) {
      toast.error("Failed to reorder fields. Please try again.");
      setDefs(defs);
      return;
    }
    router.refresh();
  }

  // Add field
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<FieldType>("TEXT");
  const [adding, setAdding] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    const res = await fetch("/api/account-fields", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: newLabel, type: newType }),
    });
    setAdding(false);
    if (res.status === 409) {
      toast.error("A field with that label already exists.");
      return;
    }
    if (!res.ok) {
      toast.error("Failed to add field. Please try again.");
      return;
    }
    const created = await res.json() as FieldDef;
    setDefs((prev) => [...prev, created]);
    setNewLabel("");
    setNewType("TEXT");
    toast.success("Field added.");
    router.refresh();
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-foreground">Custom Fields</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Define company-wide fields shown on every account.</p>
      </div>

      {/* Fields card */}
      <Card>
        <CardHeader>
          <CardTitle>Fields</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {defs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No custom fields yet — add one below.</p>
          ) : (
            <div className="divide-y divide-border">
              {defs.map((def, idx) => {
                const ed = editing[def.id];
                return (
                  <div key={def.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    {/* Order number */}
                    <span className="w-5 text-xs text-muted-foreground tabular-nums shrink-0 text-center">{idx + 1}</span>

                    {/* Label */}
                    <div className="flex-1 min-w-0">
                      {ed ? (
                        <Input
                          value={ed.label ?? def.label}
                          onChange={(e) => setEditing((prev) => ({ ...prev, [def.id]: { ...prev[def.id], label: e.target.value } }))}
                          className="h-7 text-sm w-44"
                          aria-label="Field label"
                        />
                      ) : (
                        <span className="text-sm font-medium text-foreground">{def.label}</span>
                      )}
                    </div>

                    {/* Type */}
                    <div className="w-32 shrink-0">
                      {ed ? (
                        <Select
                          items={FIELD_TYPE_LABELS}
                          value={ed.type ?? def.type}
                          onValueChange={(v) => {
                            if (v) setEditing((prev) => ({ ...prev, [def.id]: { ...prev[def.id], type: v as FieldType } }));
                          }}
                        >
                          <SelectTrigger className="h-7 text-xs w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FIELD_TYPES.map((t) => (
                              <SelectItem key={t} value={t}>{FIELD_TYPE_LABELS[t]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className="text-xs">{FIELD_TYPE_LABELS[def.type]}</Badge>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => handleReorder(def.id, "up")}
                        disabled={idx === 0}
                        aria-label="Move field up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => handleReorder(def.id, "down")}
                        disabled={idx === defs.length - 1}
                        aria-label="Move field down"
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
                            onClick={() => saveEdit(def)}
                            aria-label="Save field"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => cancelEdit(def.id)}
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
                          onClick={() => startEdit(def)}
                          aria-label="Edit field"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(def.id)}
                        aria-label="Delete field"
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

      {/* Add field card */}
      <Card>
        <CardHeader>
          <CardTitle>Add Field</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1.5">
              <Label htmlFor="new-field-label">Label <span className="text-destructive">*</span></Label>
              <Input
                id="new-field-label"
                className="w-48"
                placeholder="e.g. Total area"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-field-type">Type</Label>
              <Select items={FIELD_TYPE_LABELS} value={newType} onValueChange={(v) => { if (v) setNewType(v as FieldType); }}>
                <SelectTrigger id="new-field-type" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{FIELD_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={adding} className="shrink-0">
              <Plus className="h-4 w-4 mr-1.5" />
              {adding ? "Adding…" : "Add Field"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
