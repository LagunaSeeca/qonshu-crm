"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

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

export function StageSettings({ initialStages, shareAllLeads: initialShare }: Props) {
  const router = useRouter();
  const [stages, setStages] = useState<Stage[]>(initialStages);
  const [shareAll, setShareAll] = useState(initialShare);
  const [deleteError, setDeleteError] = useState<Record<string, string>>({});

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
      router.refresh();
    }
  }

  async function handleDelete(id: string) {
    setDeleteError((prev) => ({ ...prev, [id]: "" }));
    const res = await fetch(`/api/stages/${id}`, { method: "DELETE" });
    if (res.status === 409) {
      setDeleteError((prev) => ({ ...prev, [id]: "move its leads first" }));
    } else if (res.ok) {
      setStages((prev) => prev.filter((s) => s.id !== id));
      router.refresh();
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
    await fetch("/api/stages/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedIds: next.map((s) => s.id) }),
    });
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
    if (res.ok) {
      const created = await res.json() as Stage;
      setStages((prev) => [...prev, created]);
      setNewName("");
      setNewProb(0);
    }
    setAdding(false);
    router.refresh();
  }

  async function handleShareToggle(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.checked;
    setShareAll(val);
    await fetch("/api/company/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shareAllLeads: val }),
    });
    router.refresh();
  }

  return (
    <div className="max-w-3xl mx-auto py-6 space-y-8">
      <h1 className="text-2xl font-semibold">Stage Settings</h1>

      {/* Visibility toggle */}
      <section className="bg-white border rounded p-4">
        <label className="flex items-center gap-3 text-sm cursor-pointer">
          <input
            id="share-all-leads"
            type="checkbox"
            checked={shareAll}
            onChange={handleShareToggle}
            className="h-4 w-4"
            aria-label="Share all leads with everyone"
          />
          <span>Share all leads with everyone</span>
        </label>
      </section>

      {/* Stage list */}
      <section className="bg-white border rounded p-4 space-y-3">
        <h2 className="font-medium text-sm">Pipeline Stages</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs border-b">
              <th className="pb-2 w-8">#</th>
              <th className="pb-2">Name</th>
              <th className="pb-2">Type</th>
              <th className="pb-2">Prob %</th>
              <th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, idx) => {
              const ed = editing[stage.id];
              return (
                <tr key={stage.id} className="border-b last:border-0">
                  <td className="py-2 text-gray-400 text-xs">{idx + 1}</td>
                  <td className="py-2">
                    {ed ? (
                      <input
                        className="border rounded px-1 py-0.5 text-sm w-32"
                        value={ed.name ?? stage.name}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [stage.id]: { ...prev[stage.id], name: e.target.value } }))}
                      />
                    ) : (
                      <span>{stage.name}</span>
                    )}
                  </td>
                  <td className="py-2">
                    {ed ? (
                      <select
                        className="border rounded px-1 py-0.5 text-sm"
                        value={ed.type ?? stage.type}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [stage.id]: { ...prev[stage.id], type: e.target.value as StageType } }))}
                      >
                        {STAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    ) : (
                      <span className="text-xs text-gray-600">{stage.type}</span>
                    )}
                  </td>
                  <td className="py-2">
                    {ed ? (
                      <input
                        className="border rounded px-1 py-0.5 text-sm w-16"
                        type="number"
                        min={0}
                        max={100}
                        value={ed.probability ?? stage.probability}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [stage.id]: { ...prev[stage.id], probability: Number(e.target.value) } }))}
                      />
                    ) : (
                      <span>{stage.probability}%</span>
                    )}
                  </td>
                  <td className="py-2 text-right space-x-1">
                    <button
                      className="text-xs border rounded px-1 py-0.5 disabled:opacity-30"
                      onClick={() => handleReorder(stage.id, "up")}
                      disabled={idx === 0}
                      aria-label="Move up"
                    >↑</button>
                    <button
                      className="text-xs border rounded px-1 py-0.5 disabled:opacity-30"
                      onClick={() => handleReorder(stage.id, "down")}
                      disabled={idx === stages.length - 1}
                      aria-label="Move down"
                    >↓</button>
                    {ed ? (
                      <>
                        <button className="text-xs bg-blue-600 text-white rounded px-2 py-0.5" onClick={() => saveEdit(stage)}>Save</button>
                        <button className="text-xs border rounded px-2 py-0.5" onClick={() => cancelEdit(stage.id)}>Cancel</button>
                      </>
                    ) : (
                      <button className="text-xs border rounded px-2 py-0.5" onClick={() => startEdit(stage)}>Edit</button>
                    )}
                    <button
                      className="text-xs text-red-600 border border-red-200 rounded px-2 py-0.5"
                      onClick={() => handleDelete(stage.id)}
                    >Delete</button>
                    {deleteError[stage.id] && (
                      <span className="text-xs text-red-500 ml-1">{deleteError[stage.id]}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Add stage */}
      <section className="bg-white border rounded p-4">
        <h2 className="font-medium text-sm mb-3">Add Stage</h2>
        <form onSubmit={handleAdd} className="flex gap-2 items-end flex-wrap">
          <label className="flex flex-col gap-1 text-xs">
            Name
            <input
              className="border rounded px-2 py-1 text-sm w-36"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Type
            <select className="border rounded px-2 py-1 text-sm" value={newType} onChange={(e) => setNewType(e.target.value as StageType)}>
              {STAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Probability %
            <input
              className="border rounded px-2 py-1 text-sm w-20"
              type="number"
              min={0}
              max={100}
              value={newProb}
              onChange={(e) => setNewProb(Number(e.target.value))}
            />
          </label>
          <button className="bg-blue-600 text-white px-3 py-1 rounded text-sm" type="submit" disabled={adding}>
            {adding ? "Adding…" : "Add Stage"}
          </button>
        </form>
      </section>
    </div>
  );
}
