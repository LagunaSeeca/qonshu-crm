"use client";
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DndContext, type DragEndEvent, useDroppable, useDraggable } from "@dnd-kit/core";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LayoutGrid, List, Plus, Settings2 } from "lucide-react";

type Stage = { id: string; name: string; probability: number };
type Lead = {
  id: string;
  title: string;
  stageId: string;
  contactName: string;
  priority?: string;
};

function priorityBadge(priority?: string) {
  switch (priority) {
    case "HIGH":
      return <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 text-[11px] font-medium">HIGH</Badge>;
    case "LOW":
      return <Badge variant="outline" className="text-slate-600 border-slate-300 bg-slate-50 dark:text-slate-400 dark:border-slate-600 dark:bg-slate-900 text-[11px] font-medium">LOW</Badge>;
    default:
      return <Badge variant="outline" className="text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-400 dark:border-sky-700 dark:bg-sky-950 text-[11px] font-medium">MEDIUM</Badge>;
  }
}

function LeadCard({ lead }: { lead: Lead }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: lead.id, data: { stageId: lead.stageId } });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50 } : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="cursor-grab active:cursor-grabbing"
    >
      <Card className="mb-2 shadow-sm hover:shadow transition-shadow duration-150 border border-border">
        <CardContent className="p-3">
          <div className="font-medium text-sm text-foreground leading-snug mb-1">{lead.title}</div>
          <div className="text-xs text-muted-foreground mb-2">{lead.contactName}</div>
          <div className="flex items-center gap-2">
            {priorityBadge(lead.priority)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Column({ stage, leads }: { stage: Stage; leads: Lead[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div
      ref={setNodeRef}
      className={`flex-none w-64 rounded-lg border bg-muted/40 transition-colors duration-150 ${isOver ? "border-sky-400 bg-sky-50/60 dark:bg-sky-950/40" : "border-border"}`}
    >
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sm text-foreground">{stage.name}</span>
          <Badge variant="secondary" className="text-xs tabular-nums font-medium">{leads.length}</Badge>
        </div>
      </div>
      <div className="p-3 min-h-[60px]">
        {leads.map((l) => (
          <LeadCard key={l.id} lead={l} />
        ))}
        {leads.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No leads yet</p>
        )}
      </div>
    </div>
  );
}

interface BoardProps {
  stages: Stage[];
  leads: Lead[];
  isAdmin?: boolean;
  searchQuery?: string;
}

export function Board({ stages, leads, isAdmin, searchQuery }: BoardProps) {
  const router = useRouter();
  const [search, setSearch] = React.useState(searchQuery ?? "");

  const filteredLeads = search
    ? leads.filter(
        (l) =>
          l.title.toLowerCase().includes(search.toLowerCase()) ||
          l.contactName.toLowerCase().includes(search.toLowerCase())
      )
    : leads;

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const leadId = String(active.id);
    const toStageId = String(over.id);
    const res = await fetch(`/api/leads/${leadId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toStageId }),
    });
    if (!res.ok) {
      toast.error("Failed to move lead. Please try again.");
      router.refresh();
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* View toggle */}
        <div className="flex items-center rounded-md border border-border bg-background overflow-hidden">
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground">
            <LayoutGrid className="h-3.5 w-3.5" />
            Board
          </span>
          <Link
            href="/crm/list"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
          >
            <List className="h-3.5 w-3.5" />
            List
          </Link>
        </div>

        {/* Search */}
        <div className="flex-1 max-w-xs">
          <Input
            placeholder="Search leads..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isAdmin && (
            <Link
              href="/crm/stages"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-muted-foreground")}
            >
              <Settings2 className="h-4 w-4 mr-1.5" />
              Stages
            </Link>
          )}
          <Link
            href="/crm/list#new"
            className={cn(buttonVariants({ size: "sm" }))}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            New Lead
          </Link>
        </div>
      </div>

      {/* Kanban columns */}
      <DndContext onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto pb-4">
          {stages.map((stage) => (
            <Column
              key={stage.id}
              stage={stage}
              leads={filteredLeads.filter((l) => l.stageId === stage.id)}
            />
          ))}
          {stages.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
              <p className="text-muted-foreground text-sm mb-3">No stages configured yet.</p>
              {isAdmin && (
                <Link href="/crm/stages" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                  Configure stages
                </Link>
              )}
            </div>
          )}
        </div>
      </DndContext>
    </div>
  );
}
