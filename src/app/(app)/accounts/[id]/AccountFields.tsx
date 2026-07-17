"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ListChecks, Settings2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FieldType = "TEXT" | "NUMBER" | "CURRENCY" | "DATE";
type FieldRow = { fieldDefId: string; label: string; type: FieldType; order: number; value: string };

type Props = {
  accountId: string;
  isAdmin?: boolean;
};

function inputType(type: FieldType): string {
  switch (type) {
    case "NUMBER":
    case "CURRENCY":
      return "number";
    case "DATE":
      return "date";
    default:
      return "text";
  }
}

export function AccountFields({ accountId, isAdmin = false }: Props) {
  const [rows, setRows] = useState<FieldRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/accounts/${accountId}/fields`);
      if (!res.ok) {
        toast.error("Failed to load custom fields.");
        return;
      }
      const data = (await res.json()) as FieldRow[];
      setRows(data);
      setDrafts(Object.fromEntries(data.map((r) => [r.fieldDefId, r.value])));
    } catch {
      toast.error("Failed to load custom fields.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function saveField(fieldDefId: string) {
    const value = drafts[fieldDefId] ?? "";
    const row = rows?.find((r) => r.fieldDefId === fieldDefId);
    if (!row || row.value === value) return; // unchanged, nothing to save
    setSavingId(fieldDefId);
    try {
      const res = await fetch(`/api/accounts/${accountId}/fields`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fieldDefId, value }),
      });
      if (!res.ok) {
        toast.error("Failed to save field. Please try again.");
        return;
      }
      setRows((prev) => (prev ? prev.map((r) => (r.fieldDefId === fieldDefId ? { ...r, value } : r)) : prev));
      toast.success("Field saved.");
    } catch {
      toast.error("Failed to save field. Please try again.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border pb-4 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-semibold">Details</CardTitle>
        {isAdmin && (
          <Link
            href="/accounts/fields"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150"
          >
            <Settings2 className="size-3.5" />
            Manage fields
          </Link>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        {rows === null ? (
          <p className="text-sm text-muted-foreground py-2">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <ListChecks className="size-8 mb-2 opacity-40" />
            <p className="text-sm">No custom fields defined yet</p>
            {isAdmin && (
              <Link href="/accounts/fields" className="text-xs text-sky-700 dark:text-sky-400 hover:underline mt-1">
                Define fields
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.fieldDefId} className="space-y-1.5">
                <Label htmlFor={`field-${row.fieldDefId}`}>{row.label}</Label>
                <Input
                  id={`field-${row.fieldDefId}`}
                  type={inputType(row.type)}
                  step={row.type === "CURRENCY" ? "0.01" : undefined}
                  value={drafts[row.fieldDefId] ?? ""}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [row.fieldDefId]: e.target.value }))}
                  onBlur={() => void saveField(row.fieldDefId)}
                  disabled={savingId === row.fieldDefId}
                  className={row.type === "NUMBER" || row.type === "CURRENCY" ? "text-right tabular-nums" : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
