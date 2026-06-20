import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("shows Users link for company admin only", () => {
    const { rerender } = render(<Sidebar role="MEMBER" />);
    expect(screen.queryByText("Users")).toBeNull();
    rerender(<Sidebar role="COMPANY_ADMIN" />);
    expect(screen.getByText("Users")).toBeInTheDocument();
  });
});
