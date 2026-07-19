"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MessageSquare,
  Phone,
  Calendar,
  Mail,
  CheckCircle2,
  Circle,
  Paperclip,
  Upload,
  BarChart2,
  Landmark,
  ReceiptText,
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
import { Analytics } from "./Analytics";
import { Settlement } from "./Settlement";
import { ServiceFees } from "./ServiceFees";
import { AccountFields } from "./AccountFields";

type Activity = { id: string; kind: string; body: string; outcome: string | null; occurredAt: string; authorId: string | null };
type Task = { id: string; title: string; dueDate: string | null; done: boolean };
type Ask = { id: string; title: string; detail: string | null; status: string; createdAt: string; resolvedAt: string | null };
type Attachment = { id: string; filename: string; size: number; mime: string };
type Member = { id: string; name: string };

type Account = {
  id: string;
  name: string;
  status: string;
  website: string | null;
  industry: string | null;
  accountManagerId: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
};

type Props = {
  account: Account;
  members: Member[];
  activities: Activity[];
  tasks: Task[];
  asks: Ask[];
  attachments: Attachment[];
  isAdmin?: boolean;
};

const ACTIVITY_KINDS = ["NOTE", "CALL", "MEETING", "EMAIL"] as const;
const STATUSES = ["ACTIVE", "AT_RISK", "CHURNED"] as const;
const STATUS_LABELS: Record<string, string> = { ACTIVE: "Active", AT_RISK: "At risk", CHURNED: "Churned" };
const ACTIVITY_KIND_LABELS: Record<string, string> = { NOTE: "Note", CALL: "Call", MEETING: "Meeting", EMAIL: "Email" };

function activityIcon(kind: string) {
  switch (kind) {
    case "CALL": return <Phone className="size-3.5 text-sky-600 dark:text-sky-400" />;
    case "MEETING": return <Calendar className="size-3.5 text-violet-600 dark:text-violet-400" />;
    case "EMAIL": return <Mail className="size-3.5 text-amber-600 dark:text-amber-400" />;
    default: return <MessageSquare className="size-3.5 text-slate-500" />;
  }
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "AT_RISK":
      return <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium">AT_RISK</Badge>;
    case "CHURNED":
      return <Badge variant="outline" className="text-red-700 border-red-300 bg-red-50 dark:text-red-400 dark:border-red-700 dark:bg-red-950 font-medium">CHURNED</Badge>;
    default:
      return <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium">ACTIVE</Badge>;
  }
}

function AskStatusBadge({ status }: { status: string }) {
  if (status === "RESOLVED") {
    return <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 dark:text-green-400 dark:border-green-700 dark:bg-green-950 font-medium text-xs">RESOLVED</Badge>;
  }
  return <Badge variant="outline" className="text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950 font-medium text-xs">OPEN</Badge>;
}

function isOverdue(dueDate: string | null, done: boolean) {
  if (!dueDate || done) return false;
  return new Date(dueDate) < new Date();
}

type TabKey = "activity" | "tasks" | "asks" | "files" | "settlement" | "serviceFees" | "analytics";

export function AccountDetail({ account, members, activities, tasks, asks, attachments, isAdmin = false }: Props) {
  const router = useRouter();

  // Account fields
  const [name, setName] = useState(account.name);
  const [website, setWebsite] = useState(account.website ?? "");
  const [industry, setIndustry] = useState(account.industry ?? "");
  const [status, setStatus] = useState(account.status);
  const [accountManagerId, setAccountManagerId] = useState(account.accountManagerId ?? "");
  const [primaryContactName, setPrimaryContactName] = useState(account.primaryContactName ?? "");
  const [primaryContactEmail, setPrimaryContactEmail] = useState(account.primaryContactEmail ?? "");
  const [primaryContactPhone, setPrimaryContactPhone] = useState(account.primaryContactPhone ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch(`/api/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        website: website || null,
        industry: industry || null,
        status,
        accountManagerId: accountManagerId || undefined,
        primaryContactName: primaryContactName || null,
        primaryContactEmail: primaryContactEmail || null,
        primaryContactPhone: primaryContactPhone || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Failed to save. Please try again.");
      return;
    }
    toast.success("Account saved.");
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
    const res = await fetch(`/api/accounts/${account.id}/activities`, {
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
    const res = await fetch(`/api/accounts/${account.id}/tasks/${taskId}`, {
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
    const res = await fetch(`/api/accounts/${account.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // <input type="date"> yields YYYY-MM-DD; the API expects a full ISO datetime.
      body: JSON.stringify({ title: taskTitle, dueDate: taskDue ? new Date(taskDue).toISOString() : undefined }),
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

  // Asks
  const [askTitle, setAskTitle] = useState("");
  const [askDetail, setAskDetail] = useState("");
  const [addingAsk, setAddingAsk] = useState(false);

  async function handleAskAction(askId: string, action: "resolve" | "reopen") {
    const res = await fetch(`/api/accounts/${account.id}/asks/${askId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      toast.error("Failed to update ask. Please try again.");
      return;
    }
    toast.success(action === "resolve" ? "Ask resolved." : "Ask reopened.");
    router.refresh();
  }

  async function handleAddAsk(e: React.FormEvent) {
    e.preventDefault();
    setAddingAsk(true);
    const res = await fetch(`/api/accounts/${account.id}/asks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: askTitle, detail: askDetail || undefined }),
    });
    setAddingAsk(false);
    if (!res.ok) {
      toast.error("Failed to add ask. Please try again.");
      return;
    }
    toast.success("Ask added.");
    setAskTitle("");
    setAskDetail("");
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
    const res = await fetch(`/api/accounts/${account.id}/attachments`, { method: "POST", body: fd });
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
  const [activeTab, setActiveTab] = useState<TabKey>("activity");

  const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const managerItems = Object.fromEntries(members.map((m) => [m.id, m.name]));

  const tabs: { key: TabKey; label: string; disabled?: boolean }[] = [
    { key: "activity", label: "Activity" },
    { key: "tasks", label: "Tasks" },
    { key: "asks", label: "Asks" },
    { key: "files", label: "Files" },
    { key: "settlement", label: "Settlement" },
    { key: "serviceFees", label: "Service fees" },
    { key: "analytics", label: "Analytics" },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">{account.name}</h1>
        <div className="mt-1">
          <StatusBadge status={account.status} />
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
        {/* LEFT: Account fields card + custom fields (Details) card */}
        <div className="space-y-6">
        <Card>
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-base font-semibold">Account Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="accName">Name <span className="text-destructive">*</span></Label>
                <Input id="accName" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="website">Website</Label>
                <Input id="website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="industry">Industry</Label>
                <Input id="industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. SaaS" />
              </div>

              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select items={STATUS_LABELS} value={status} onValueChange={(val) => { if (val) setStatus(val); }}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Account Manager</Label>
                <Select items={managerItems} value={accountManagerId} onValueChange={(val) => { if (val) setAccountManagerId(val); }}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select manager…" />
                  </SelectTrigger>
                  <SelectContent>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              <p className="text-sm font-medium text-foreground">Primary Contact</p>

              <div className="space-y-1.5">
                <Label htmlFor="contactName">Name</Label>
                <Input id="contactName" value={primaryContactName} onChange={(e) => setPrimaryContactName(e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="contactEmail">Email</Label>
                  <Input id="contactEmail" type="email" value={primaryContactEmail} onChange={(e) => setPrimaryContactEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contactPhone">Phone</Label>
                  <Input id="contactPhone" value={primaryContactPhone} onChange={(e) => setPrimaryContactPhone(e.target.value)} />
                </div>
              </div>

              <Separator />

              <div className="flex justify-end">
                <Button type="submit" disabled={saving} size="sm">
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <AccountFields accountId={account.id} isAdmin={isAdmin} />
        </div>

        {/* RIGHT: Manual tabs — all panels stay in DOM */}
        <div className="w-full">
          {/* Tab bar */}
          <div className="inline-flex items-center justify-center rounded-lg p-[3px] bg-muted mb-4 h-8 gap-0">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => !tab.disabled && setActiveTab(tab.key)}
                disabled={tab.disabled}
                className={[
                  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-0.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tab.disabled
                    ? "text-foreground/30 cursor-not-allowed"
                    : activeTab === tab.key
                    ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
                    : "text-foreground/60 hover:text-foreground",
                ].join(" ")}
                aria-selected={activeTab === tab.key}
                role="tab"
              >
                {tab.key === "analytics" && <BarChart2 className="size-3" />}
                {tab.key === "settlement" && <Landmark className="size-3" />}
                {tab.key === "serviceFees" && <ReceiptText className="size-3" />}
                {tab.label}
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

          {/* Asks panel */}
          <div hidden={activeTab !== "asks"}>
            <Card>
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-base font-semibold">Asks</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                {asks.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                    <MessageSquare className="size-8 mb-2 opacity-40" />
                    <p className="text-sm">No asks yet</p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {asks.map((ask) => (
                      <li key={ask.id} className="text-sm border border-border rounded-md p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-foreground">{ask.title}</span>
                            {ask.detail && <p className="text-muted-foreground text-xs mt-0.5">{ask.detail}</p>}
                          </div>
                          <AskStatusBadge status={ask.status} />
                        </div>
                        <div className="flex items-center gap-2">
                          {ask.status === "OPEN" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleAskAction(ask.id, "resolve")}
                              className="h-6 px-2 text-xs"
                            >
                              Resolve
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleAskAction(ask.id, "reopen")}
                              className="h-6 px-2 text-xs"
                            >
                              Reopen
                            </Button>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {new Date(ask.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <Separator />

                <form onSubmit={handleAddAsk} className="space-y-3">
                  <p className="text-sm font-medium text-foreground">Add Ask</p>
                  <div className="space-y-1.5">
                    <Label htmlFor="askTitle">Title <span className="text-destructive">*</span></Label>
                    <Input
                      id="askTitle"
                      placeholder="What are you asking for…"
                      value={askTitle}
                      onChange={(e) => setAskTitle(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="askDetail">Detail (optional)</Label>
                    <Textarea
                      id="askDetail"
                      rows={2}
                      placeholder="More context…"
                      value={askDetail}
                      onChange={(e) => setAskDetail(e.target.value)}
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={addingAsk}>
                    {addingAsk ? "Adding…" : "Add ask"}
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
                          href={`/api/accounts/${account.id}/attachments/${att.id}`}
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

          {/* Settlement panel */}
          <div hidden={activeTab !== "settlement"}>
            <Settlement accountId={account.id} isAdmin={isAdmin} />
          </div>

          {/* Service fees panel */}
          <div hidden={activeTab !== "serviceFees"}>
            <ServiceFees accountId={account.id} isAdmin={isAdmin} />
          </div>

          {/* Analytics panel */}
          <div hidden={activeTab !== "analytics"}>
            <Analytics accountId={account.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
