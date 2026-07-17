import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
import { AccountDetail } from "./AccountDetail";

const base = {
  account: { id: "a1", name: "Partner Co", status: "ACTIVE", website: "", industry: "SaaS", accountManagerId: "u", primaryContactName: "Jane", primaryContactEmail: "", primaryContactPhone: "" },
  members: [{ id: "u", name: "M1" }],
  activities: [{ id: "ac1", kind: "MEETING", body: "kickoff call", outcome: null, occurredAt: new Date().toISOString(), authorId: "u" }],
  tasks: [{ id: "t1", title: "send deck", dueDate: null, done: false }],
  asks: [{ id: "k1", title: "need API key", detail: null, status: "OPEN", createdAt: new Date().toISOString(), resolvedAt: null }],
  attachments: [{ id: "f1", filename: "msa.pdf", size: 10, mime: "application/pdf" }],
};

describe("AccountDetail", () => {
  it("renders account, activity, task, ask, attachment", () => {
    render(<AccountDetail {...base} />);
    expect(screen.getByText("Partner Co")).toBeInTheDocument();
    expect(screen.getByText("kickoff call")).toBeInTheDocument();
    expect(screen.getByText("send deck")).toBeInTheDocument();
    expect(screen.getByText("need API key")).toBeInTheDocument();
    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
  });
});
