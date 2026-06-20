"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Stage = { id: string; name: string };

export function LeadCreate({ stages }: { stages: Stage[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [contactName, setContactName] = useState("");
  const [stageId, setStageId] = useState(stages[0]?.id ?? "");
  const [value, setValue] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await fetch("/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, contactName, stageId, value: value ? Number(value) : undefined, priority }),
    });
    if (r.ok) {
      setTitle(""); setContactName(""); setValue(""); setPriority("MEDIUM");
      setOpen(false);
      router.refresh();
    } else {
      setError("Failed to create lead");
    }
  }

  return (
    <div className="mb-4">
      <button className="bg-black text-white px-3 py-1 rounded text-sm" onClick={() => setOpen(!open)}>
        + New Lead
      </button>
      {open && (
        <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2 items-end">
          <input className="border p-2 rounded text-sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <input className="border p-2 rounded text-sm" placeholder="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} required />
          <select className="border p-2 rounded text-sm" value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input className="border p-2 rounded text-sm w-28" placeholder="Value" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} />
          <select className="border p-2 rounded text-sm" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option>LOW</option><option>MEDIUM</option><option>HIGH</option>
          </select>
          <button className="bg-blue-600 text-white px-3 py-2 rounded text-sm" type="submit">Create</button>
          {error && <span className="text-red-600 text-sm">{error}</span>}
        </form>
      )}
    </div>
  );
}
