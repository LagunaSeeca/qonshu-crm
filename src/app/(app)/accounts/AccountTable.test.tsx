import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AccountTable } from "./AccountTable";

describe("AccountTable", () => {
  it("renders account rows with status + manager", () => {
    render(<AccountTable rows={[{ id: "1", name: "Partner Co", status: "ACTIVE", managerName: "M1", value: 5000, industry: "SaaS" }]} />);
    expect(screen.getByText("Partner Co")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
  });
});
