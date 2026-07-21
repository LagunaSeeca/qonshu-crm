import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeadTable } from "./LeadTable";

describe("LeadTable", () => {
  it("renders lead rows with stage", () => {
    render(<LeadTable rows={[{ id: "1", title: "Acme deal", contactName: "Jane", phone: null, stageName: "New", priority: "HIGH", ownerName: "M1", lastActivityAt: null, nextDate: null }]} />);
    expect(screen.getByText("Acme deal")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("shows phone, last-activity and next dates when present", () => {
    render(<LeadTable rows={[{ id: "2", title: "Beta deal", contactName: "Bob", phone: "+994 50 111 22 33", stageName: "Contacted", priority: "MEDIUM", ownerName: "M2", lastActivityAt: "2026-06-08T00:00:00Z", nextDate: "2026-07-15T00:00:00Z" }]} />);
    expect(screen.getByText("+994 50 111 22 33")).toBeInTheDocument();
    expect(screen.getByText("Jun 8")).toBeInTheDocument();
    expect(screen.getByText("Jul 15")).toBeInTheDocument();
  });
});
