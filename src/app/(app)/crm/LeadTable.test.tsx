import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeadTable } from "./LeadTable";

describe("LeadTable", () => {
  it("renders lead rows with stage + value", () => {
    render(<LeadTable rows={[{ id: "1", title: "Acme deal", contactName: "Jane", stageName: "New", value: 1000, priority: "HIGH", ownerName: "M1" }]} />);
    expect(screen.getByText("Acme deal")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });
});
