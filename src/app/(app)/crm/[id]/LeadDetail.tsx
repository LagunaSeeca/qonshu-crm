"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Stage = { id: string; name: string; type: string };
type Activity = { id: string; kind: string; body: string; outcome: string | null; occurredAt: string; authorId: string | null };
type Task = { id: string; title: string; dueDate: string | null; done: boolean };
type Attachment = { id: string; filename: string; size: number; mime: string };
type Member = { id: string; name: string };

type Lead = {
  id: string;
  title: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  value: number;
  priority: string;
  stageId: string;
  lostReason: string | null;
};

type Props = {
  lead: Lead;
  stages: Stage[];
  activities: Activity[];
  tasks: Task[];
  attachments: Attachment[];
  members: Member[];
};

const ACTIVITY_KINDS = ["NOTE", "CALL", "MEETING", "EMAIL"] as const;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;

export function LeadDetail({ lead, stages, activities, tasks, attachments, members }: Props) {
  const router = useRouter();

  // --- Section 1: Lead fields ---
  const [title, setTitle] = useState(lead.title);
  const [contactName, setContactName] = useState(lead.contactName);
  const [email, setEmail] = useState(lead.email ?? "");
  const [phone, setPhone] = useState(lead.phone ?? "");
  const [companyName, setCompanyName] = useState(lead.companyName ?? "");
  const [value, setValue] = useState(String(lead.value));
  const [priority, setPriority] = useState(lead.priority);
  const [stageId, setStageId] = useState(lead.stageId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, contactName, email: email || null, phone: phone || null, companyName: companyName || null, value: Number(value), priority }),
    });
    setSaving(false);
    if (!res.ok) {
      setSaveError("Failed to save. Please try again.");
      return;
    }
    router.refresh();
  }

  async function handleMove(e: React.ChangeEvent<HTMLSelectElement>) {
    const toStageId = e.target.value;
    setStageId(toStageId);
    setMoveError(null);
    const targetStage = stages.find((s) => s.id === toStageId);
    let lostReason: string | null = null;
    if (targetStage?.type === "LOST") {
      lostReason = window.prompt("Reason for losing this lead?") ?? null;
    }
    const res = await fetch(`/api/leads/${lead.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toStageId, lostReason }),
    });
    if (!res.ok) {
      setMoveError("Failed to move stage. Please try again.");
      setStageId(lead.stageId);
      return;
    }
    router.refresh();
  }

  // --- Section 2: Activities ---
  const [actKind, setActKind] = useState<string>("NOTE");
  const [actBody, setActBody] = useState("");
  const [actOutcome, setActOutcome] = useState("");
  const [addingActivity, setAddingActivity] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  async function handleAddActivity(e: React.FormEvent) {
    e.preventDefault();
    setAddingActivity(true);
    setActivityError(null);
    const res = await fetch(`/api/leads/${lead.id}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: actKind, body: actBody, outcome: actOutcome || undefined }),
    });
    setAddingActivity(false);
    if (!res.ok) {
      setActivityError("Failed to add activity. Please try again.");
      return;
    }
    setActBody("");
    setActOutcome("");
    router.refresh();
  }

  // --- Section 3: Tasks ---
  const [taskTitle, setTaskTitle] = useState("");
  const [addingTask, setAddingTask] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  async function handleToggleTask(taskId: string, done: boolean) {
    const res = await fetch(`/api/leads/${lead.id}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done }),
    });
    if (!res.ok) {
      setTaskError("Failed to update task. Please try again.");
      return;
    }
    setTaskError(null);
    router.refresh();
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    setAddingTask(true);
    setTaskError(null);
    const res = await fetch(`/api/leads/${lead.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: taskTitle }),
    });
    setAddingTask(false);
    if (!res.ok) {
      setTaskError("Failed to add task. Please try again.");
      return;
    }
    setTaskTitle("");
    router.refresh();
  }

  // --- Attachments ---
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/leads/${lead.id}/attachments`, { method: "POST", body: fd });
    setUploading(false);
    if (!res.ok) {
      setUploadError("Failed to upload attachment. Please try again.");
      e.target.value = "";
      return;
    }
    e.target.value = "";
    router.refresh();
  }

  const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));

  return (
    <div className="space-y-8 max-w-3xl mx-auto py-6">
      {/* Section 1: Lead Fields */}
      <section className="bg-white border rounded p-6 space-y-4">
        <h1 className="text-2xl font-bold">{lead.title}</h1>
        <h2 className="text-xl font-semibold">Lead Details</h2>
        <form onSubmit={handleSave} className="grid grid-cols-2 gap-4">
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            Title
            <input className="border rounded px-2 py-1" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Contact Name
            <input className="border rounded px-2 py-1" value={contactName} onChange={(e) => setContactName(e.target.value)} required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Company
            <input className="border rounded px-2 py-1" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input className="border rounded px-2 py-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Phone
            <input className="border rounded px-2 py-1" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Value
            <input className="border rounded px-2 py-1" type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Priority
            <select className="border rounded px-2 py-1" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            Stage
            <select className="border rounded px-2 py-1" value={stageId} onChange={handleMove}>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {moveError && <p className="col-span-2 text-sm text-red-600">{moveError}</p>}
          {lead.lostReason && (
            <p className="col-span-2 text-sm text-red-600">Lost reason: {lead.lostReason}</p>
          )}
          <div className="col-span-2">
            <button className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            {saveError && <p className="text-sm text-red-600 mt-1">{saveError}</p>}
          </div>
        </form>
      </section>

      {/* Section 2: Activity Timeline */}
      <section className="bg-white border rounded p-6 space-y-4">
        <h2 className="text-xl font-semibold">Activity Timeline</h2>
        <ul className="space-y-3">
          {activities.map((a) => (
            <li key={a.id} className="border-l-2 border-blue-300 pl-4 text-sm">
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-0.5">
                <span className="font-medium">{a.kind}</span>
                <span>{new Date(a.occurredAt).toLocaleDateString()}</span>
                <span>{(a.authorId ? memberMap[a.authorId] : null) ?? a.authorId ?? "unknown"}</span>
              </div>
              <p>{a.body}</p>
              {a.outcome && <p className="text-gray-500 italic text-xs mt-0.5">Outcome: {a.outcome}</p>}
            </li>
          ))}
        </ul>
        <form onSubmit={handleAddActivity} className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Add Activity</h3>
          <div className="flex gap-2">
            <select className="border rounded px-2 py-1 text-sm" value={actKind} onChange={(e) => setActKind(e.target.value)}>
              {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <textarea
            className="border rounded px-2 py-1 text-sm w-full"
            rows={2}
            placeholder="Notes…"
            value={actBody}
            onChange={(e) => setActBody(e.target.value)}
            required
          />
          <input
            className="border rounded px-2 py-1 text-sm w-full"
            placeholder="Outcome (optional)"
            value={actOutcome}
            onChange={(e) => setActOutcome(e.target.value)}
          />
          <button className="bg-blue-600 text-white px-3 py-1 rounded text-sm" type="submit" disabled={addingActivity}>
            {addingActivity ? "Adding…" : "Add"}
          </button>
          {activityError && <p className="text-sm text-red-600 mt-1">{activityError}</p>}
        </form>
      </section>

      {/* Section 3: Tasks */}
      <section className="bg-white border rounded p-6 space-y-4">
        <h2 className="text-xl font-semibold">Tasks</h2>
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) => handleToggleTask(t.id, e.target.checked)}
                className="h-4 w-4"
              />
              <span className={t.done ? "line-through text-gray-400" : ""}>{t.title}</span>
              {t.dueDate && (
                <span className="text-xs text-gray-500 ml-auto">{new Date(t.dueDate).toLocaleDateString()}</span>
              )}
            </li>
          ))}
        </ul>
        {taskError && <p className="text-sm text-red-600">{taskError}</p>}
        <form onSubmit={handleAddTask} className="flex gap-2 border-t pt-4">
          <input
            className="border rounded px-2 py-1 text-sm flex-1"
            placeholder="New task…"
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            required
          />
          <button className="bg-blue-600 text-white px-3 py-1 rounded text-sm" type="submit" disabled={addingTask}>
            {addingTask ? "Adding…" : "Add"}
          </button>
        </form>
      </section>

      {/* Section 4: Attachments */}
      <section className="bg-white border rounded p-6 space-y-4">
        <h2 className="text-xl font-semibold">Attachments</h2>
        <ul className="space-y-2">
          {attachments.map((att) => (
            <li key={att.id} className="flex items-center gap-3 text-sm">
              <a
                href={`/api/leads/${lead.id}/attachments/${att.id}`}
                className="text-blue-600 underline"
                download={att.filename}
              >
                {att.filename}
              </a>
              <span className="text-xs text-gray-500">{(att.size / 1024).toFixed(1)} KB</span>
            </li>
          ))}
        </ul>
        <div className="border-t pt-4">
          <label className="text-sm flex flex-col gap-1">
            <span className="font-medium">Upload attachment</span>
            <input type="file" onChange={handleUpload} disabled={uploading} className="text-sm" />
          </label>
          {uploading && <p className="text-xs text-gray-500 mt-1">Uploading…</p>}
          {uploadError && <p className="text-sm text-red-600 mt-1">{uploadError}</p>}
        </div>
      </section>
    </div>
  );
}
