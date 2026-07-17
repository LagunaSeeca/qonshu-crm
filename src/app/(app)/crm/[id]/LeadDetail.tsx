"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MessageSquare,
  Phone,
  Calendar,
  Mail,
  ArrowRightLeft,
  CheckCircle2,
  Circle,
  Paperclip,
  Upload,
  AlertCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
const PRIORITY_LABELS: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
const ACTIVITY_KIND_LABELS: Record<string, string> = { NOTE: "Note", CALL: "Call", MEETING: "Meeting", EMAIL: "Email" };

function activityIcon(kind: string) {
  switch (kind) {
    case "CALL": return <Phone className="size-3.5 text-sky-600 dark:text-sky-400" />;
    case "MEETING": return <Calendar className="size-3.5 text-violet-600 dark:text-violet-400" />;
    case "EMAIL": return <Mail className="size-3.5 text-amber-600 dark:text-amber-400" />;
    case "STAGE_CHANGE": return <ArrowRightLeft className="size-3.5 text-slate-500" />;
    default: return <MessageSquare className="size-3.5 text-slate-500" />;
  }
}

function PriorityBadge({ priority }: { priority: string }) {
  switch (priority) {
    case "HIGH":
      return <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium">HIGH</Badge>;
    case "LOW":
      return <Badge variant="outline" className="text-slate-600 border-slate-300 bg-slate-50 dark:text-slate-400 dark:border-slate-600 dark:bg-slate-900 font-medium">LOW</Badge>;
    default:
      return <Badge variant="outline" className="text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950 font-medium">MEDIUM</Badge>;
  }
}

function isOverdue(dueDate: string | null, done: boolean) {
  if (!dueDate || done) return false;
  return new Date(dueDate) < new Date();
}

export function LeadDetail({ lead, stages, activities, tasks, attachments, members }: Props) {
  const router = useRouter();

  // Lead fields
  const [title, setTitle] = useState(lead.title);
  const [contactName, setContactName] = useState(lead.contactName);
  const [email, setEmail] = useState(lead.email ?? "");
  const [phone, setPhone] = useState(lead.phone ?? "");
  const [companyName, setCompanyName] = useState(lead.companyName ?? "");
  const [value, setValue] = useState(String(lead.value));
  const [priority, setPriority] = useState(lead.priority);
  const [stageId, setStageId] = useState(lead.stageId);
  const [saving, setSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, contactName, email: email || null, phone: phone || null, companyName: companyName || null, value: Number(value), priority }),
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Failed to save. Please try again.");
      return;
    }
    toast.success("Lead saved.");
    router.refresh();
  }

  async function handleMove(toStageId: string) {
    setStageId(toStageId);
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
      toast.error("Failed to move stage. Please try again.");
      setStageId(lead.stageId);
      return;
    }
    router.refresh();
  }

  // Activities
  const [actKind, setActKind] = useState<string>("NOTE");
  const [actBody, setActBody] = useState("");
  const [actOutcome, setActOutcome] = useState("");
  const [addingActivity, setAddingActivity] = useState(false);

  async function handleAddActivity(e: React.FormEvent) {
    e.preventDefault();
    setAddingActivity(true);
    const res = await fetch(`/api/leads/${lead.id}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: actKind, body: actBody, outcome: actOutcome || undefined }),
    });
    setAddingActivity(false);
    if (!res.ok) {
      toast.error("Failed to add activity. Please try again.");
      return;
    }
    toast.success("Activity added.");
    setActBody("");
    setActOutcome("");
    router.refresh();
  }

  // Tasks
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [addingTask, setAddingTask] = useState(false);

  async function handleToggleTask(taskId: string, done: boolean) {
    const res = await fetch(`/api/leads/${lead.id}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done }),
    });
    if (!res.ok) {
      toast.error("Failed to update task. Please try again.");
      return;
    }
    router.refresh();
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    setAddingTask(true);
    const res = await fetch(`/api/leads/${lead.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: taskTitle, dueDate: taskDue || undefined }),
    });
    setAddingTask(false);
    if (!res.ok) {
      toast.error("Failed to add task. Please try again.");
      return;
    }
    toast.success("Task added.");
    setTaskTitle("");
    setTaskDue("");
    router.refresh();
  }

  // Attachments
  const [uploading, setUploading] = useState(false);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/leads/${lead.id}/attachments`, { method: "POST", body: fd });
    setUploading(false);
    e.target.value = "";
    if (!res.ok) {
      toast.error("Failed to upload attachment. Please try again.");
      return;
    }
    toast.success("File uploaded.");
    router.refresh();
  }

  // Manual tabs — keeps all panels in DOM so tests can find text in inactive tabs
  const [activeTab, setActiveTab] = useState<"activity" | "tasks" | "files">("activity");
  const [converting, setConverting] = useState(false);

  const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const stageItems = Object.fromEntries(stages.map((s) => [s.id, s.name]));
  const currentStage = stages.find((s) => s.id === stageId);

  async function handleConvert() {
    setConverting(true);
    try {
      const res = await fetch("/api/accounts/from-lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId: lead.id }),
      });
      if (res.status === 409) {
        toast.error("Lead already converted");
        return;
      }
      if (!res.ok) {
        toast.error("Failed to convert lead");
        return;
      }
      const created = await res.json();
      toast.success("Converted to account");
      router.push("/accounts/" + created.id);
    } catch {
      toast.error("Failed to convert lead");
    } finally {
      setConverting(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{lead.title}</h1>
          {lead.lostReason && (
            <div className="flex items-center gap-1.5 mt-1 text-sm text-destructive">
              <AlertCircle className="size-3.5" />
              <span>Lost reason: {lead.lostReason}</span>
            </div>
          )}
        </div>
        {currentStage?.type === "WON" && (
          <Button size="sm" onClick={handleConvert} disabled={converting}>
            {converting ? "Converting…" : "Convert to Account"}
          </Button>
        )}
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
        {/* LEFT: Lead fields card */}
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">Lead Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">Title <span className="text-destructive">*</span></Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contactName">Contact Name <span className="text-destructive">*</span></Label>
                <Input id="contactName" value={contactName} onChange={(e) => setContactName(e.target.value)} required />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="companyName">Company</Label>
                <Input id="companyName" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="value">Value ($)</Label>
                  <Input id="value" type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} className="tabular-nums" />
                </div>
                <div className="space-y-1.5">
                  <Label>Priority</Label>
                  <Select items={PRIORITY_LABELS} value={priority} onValueChange={(val) => { if (val) setPriority(val); }}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRIORITIES.map((p) => (
                        <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Stage</Label>
                <Select items={stageItems} value={stageId} onValueChange={(val) => { if (val) handleMove(val); }}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {currentStage && (
                  <div className="mt-1">
                    {currentStage.type === "WON" && <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium text-xs">WON</Badge>}
                    {currentStage.type === "LOST" && <Badge variant="outline" className="text-red-700 border-red-300 bg-red-50 dark:text-red-400 dark:border-red-700 dark:bg-red-950 font-medium text-xs">LOST</Badge>}
                    {currentStage.type === "OPEN" && <Badge variant="outline" className="text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950 font-medium text-xs">OPEN</Badge>}
                  </div>
                )}
              </div>

              <Separator />

              <div className="flex items-center justify-between gap-3">
                <PriorityBadge priority={priority} />
                <Button type="submit" disabled={saving} size="sm">
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* RIGHT: Manual tabs — all panels stay in DOM */}
        <div className="w-full">
          {/* Tab bar */}
          <div className="inline-flex items-center justify-center rounded-lg p-[3px] bg-muted mb-4 h-8 gap-0">
            {(["activity", "tasks", "files"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={[
                  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-0.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  activeTab === tab
                    ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
                    : "text-foreground/60 hover:text-foreground",
                ].join(" ")}
                aria-selected={activeTab === tab}
                role="tab"
              >
                {tab === "activity" ? "Activity" : tab === "tasks" ? "Tasks" : "Files"}
              </button>
            ))}
          </div>

          {/* Activity panel */}
          <div hidden={activeTab !== "activity"}>
            <Card>
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-base font-semibold">Activity Timeline</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                {activities.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                    <MessageSquare className="size-8 mb-2 opacity-40" />
                    <p className="text-sm">No activity yet</p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {activities.map((a) => (
                      <li key={a.id} className="flex gap-3 text-sm">
                        <div className="mt-0.5 flex-none flex items-center justify-center size-6 rounded-full bg-muted">
                          {activityIcon(a.kind)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-0.5">
                            <span className="font-medium text-foreground">{a.kind}</span>
                            <span>{new Date(a.occurredAt).toLocaleDateString()}</span>
                            <span>{(a.authorId ? memberMap[a.authorId] : null) ?? a.authorId ?? "unknown"}</span>
                          </div>
                          <p className="text-foreground">{a.body}</p>
                          {a.outcome && <p className="text-muted-foreground italic text-xs mt-0.5">Outcome: {a.outcome}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <Separator />

                <form onSubmit={handleAddActivity} className="space-y-3">
                  <p className="text-sm font-medium text-foreground">Add Activity</p>
                  <div className="space-y-1.5">
                    <Label>Kind</Label>
                    <Select items={ACTIVITY_KIND_LABELS} value={actKind} onValueChange={(val) => { if (val) setActKind(val); }}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTIVITY_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>{ACTIVITY_KIND_LABELS[k]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="actBody">Notes <span className="text-destructive">*</span></Label>
                    <Textarea
                      id="actBody"
                      rows={2}
                      placeholder="Notes…"
                      value={actBody}
                      onChange={(e) => setActBody(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="actOutcome">Outcome (optional)</Label>
                    <Input
                      id="actOutcome"
                      placeholder="Outcome…"
                      value={actOutcome}
                      onChange={(e) => setActOutcome(e.target.value)}
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={addingActivity}>
                    {addingActivity ? "Adding…" : "Add activity"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          {/* Tasks panel */}
          <div hidden={activeTab !== "tasks"}>
            <Card>
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-base font-semibold">Tasks</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                {tasks.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                    <CheckCircle2 className="size-8 mb-2 opacity-40" />
                    <p className="text-sm">No tasks yet</p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {tasks.map((t) => {
                      const overdue = isOverdue(t.dueDate, t.done);
                      return (
                        <li key={t.id} className="flex items-center gap-3 text-sm">
                          <button
                            type="button"
                            className="flex-none cursor-pointer text-muted-foreground hover:text-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            onClick={() => handleToggleTask(t.id, !t.done)}
                            aria-label={t.done ? "Mark as not done" : "Mark as done"}
                          >
                            {t.done
                              ? <CheckCircle2 className="size-4 text-green-600 dark:text-green-400" />
                              : <Circle className="size-4" />
                            }
                          </button>
                          <span className={t.done ? "line-through text-muted-foreground flex-1 min-w-0" : "flex-1 min-w-0 text-foreground"}>
                            {t.title}
                          </span>
                          {t.dueDate && (
                            <span className="text-xs text-muted-foreground ml-auto shrink-0">
                              {new Date(t.dueDate).toLocaleDateString()}
                            </span>
                          )}
                          {overdue && (
                            <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium text-xs shrink-0">
                              Overdue
                            </Badge>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <Separator />

                <form onSubmit={handleAddTask} className="space-y-3">
                  <p className="text-sm font-medium text-foreground">Add Task</p>
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-1.5">
                      <Label htmlFor="taskTitle">Title <span className="text-destructive">*</span></Label>
                      <Input
                        id="taskTitle"
                        placeholder="New task…"
                        value={taskTitle}
                        onChange={(e) => setTaskTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="taskDue">Due date</Label>
                      <Input
                        id="taskDue"
                        type="date"
                        value={taskDue}
                        onChange={(e) => setTaskDue(e.target.value)}
                        className="w-36"
                      />
                    </div>
                  </div>
                  <Button type="submit" size="sm" disabled={addingTask}>
                    {addingTask ? "Adding…" : "Add task"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          {/* Files panel */}
          <div hidden={activeTab !== "files"}>
            <Card>
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-base font-semibold">Files</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                {attachments.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                    <Paperclip className="size-8 mb-2 opacity-40" />
                    <p className="text-sm">No files yet</p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {attachments.map((att) => (
                      <li key={att.id} className="flex items-center gap-3 text-sm">
                        <Paperclip className="size-4 text-muted-foreground flex-none" />
                        <a
                          href={`/api/leads/${lead.id}/attachments/${att.id}`}
                          className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded flex-1 min-w-0 truncate"
                          download={att.filename}
                        >
                          {att.filename}
                        </a>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {(att.size / 1024).toFixed(1)} KB
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="fileUpload" className="flex items-center gap-1.5 cursor-pointer">
                    <Upload className="size-4" />
                    Upload attachment
                  </Label>
                  <Input
                    id="fileUpload"
                    type="file"
                    onChange={handleUpload}
                    disabled={uploading}
                    className="cursor-pointer"
                  />
                  {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
