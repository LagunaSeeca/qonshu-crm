"use client";
import { useRouter } from "next/navigation";
import { DndContext, type DragEndEvent, useDroppable, useDraggable } from "@dnd-kit/core";

type Stage = { id: string; name: string };
type Lead = { id: string; title: string; stageId: string; value: number; contactName: string };

function LeadCard({ lead }: { lead: Lead }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: lead.id, data: { stageId: lead.stageId } });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="bg-white border rounded p-2 mb-2 shadow-sm cursor-grab text-sm"
    >
      <div className="font-medium">{lead.title}</div>
      <div className="text-gray-500 text-xs">{lead.contactName}</div>
      <div className="text-xs text-right mt-1">{lead.value.toLocaleString()}</div>
    </div>
  );
}

function Column({ stage, leads }: { stage: Stage; leads: Lead[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = leads.reduce((s, l) => s + l.value, 0);
  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-w-48 bg-gray-50 rounded p-3 border ${isOver ? "border-blue-400 bg-blue-50" : ""}`}
    >
      <div className="font-semibold text-sm mb-1">{stage.name}</div>
      <div className="text-xs text-gray-500 mb-3">
        {leads.length} lead{leads.length !== 1 ? "s" : ""} · {total.toLocaleString()}
      </div>
      {leads.map((l) => (
        <LeadCard key={l.id} lead={l} />
      ))}
    </div>
  );
}

export function Board({ stages, leads }: { stages: Stage[]; leads: Lead[] }) {
  const router = useRouter();

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const leadId = String(active.id);
    const toStageId = String(over.id);
    await fetch(`/api/leads/${leadId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toStageId }),
    });
    router.refresh();
  }

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => (
          <Column key={stage.id} stage={stage} leads={leads.filter((l) => l.stageId === stage.id)} />
        ))}
      </div>
    </DndContext>
  );
}
