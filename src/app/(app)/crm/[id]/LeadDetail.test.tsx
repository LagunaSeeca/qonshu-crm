import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeadDetail, moveResultToast } from "./LeadDetail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const base = {
  lead: { id: "l1", title: "Acme", contactName: "Jane", email: "j@a.com", phone: "", companyName: "Acme", priority: "HIGH", stageId: "s1", lostReason: null },
  stages: [{ id: "s1", name: "New", type: "OPEN" }],
  activities: [{ id: "a1", kind: "NOTE", body: "called", outcome: null, occurredAt: new Date().toISOString(), authorId: "u" }],
  tasks: [{ id: "t1", title: "follow up", dueDate: null, done: false }],
  attachments: [{ id: "f1", filename: "doc.pdf", size: 12, mime: "application/pdf" }],
  members: [{ id: "u", name: "M1" }],
};

describe("LeadDetail", () => {
  it("renders lead, activity, task, attachment", () => {
    render(<LeadDetail {...base} />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("called")).toBeInTheDocument();
    expect(screen.getByText("follow up")).toBeInTheDocument();
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
  });
});

// moveResultToast drives the post-move toast: a failed auto-conversion on a Won move must never
// read as an unqualified success (see moveLeadStage in src/lib/tenant/leads.ts, which swallows
// that failure server-side so the stage move still stands).
describe("moveResultToast", () => {
  it("returns null for a move into a non-Won stage, preserving the existing silent-success behavior", () => {
    expect(moveResultToast({ type: "OPEN" }, false)).toBeNull();
    expect(moveResultToast({ type: "LOST" }, false)).toBeNull();
    expect(moveResultToast(undefined, false)).toBeNull();
  });

  it("returns a success outcome for a Won move that auto-converted", () => {
    const outcome = moveResultToast({ type: "WON" }, true);
    expect(outcome).not.toBeNull();
    expect(outcome!.variant).toBe("success");
  });

  it("returns a warning outcome (not success) for a Won move whose auto-conversion failed, pointing at the recovery path", () => {
    const outcome = moveResultToast({ type: "WON" }, false);
    expect(outcome).not.toBeNull();
    expect(outcome!.variant).toBe("warning");
    expect(outcome!.message.toLowerCase()).toContain("convert to account");
  });
});
