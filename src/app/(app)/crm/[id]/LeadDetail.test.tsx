import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeadDetail } from "./LeadDetail";

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
