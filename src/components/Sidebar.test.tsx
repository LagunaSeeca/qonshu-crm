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

  it("shows Companies link for SUPER_ADMIN", () => {
    render(<Sidebar role="SUPER_ADMIN" />);
    expect(screen.getByText("Companies")).toBeInTheDocument();
  });

  it("SUPER_ADMIN does NOT see Users link", () => {
    render(<Sidebar role="SUPER_ADMIN" />);
    expect(screen.queryByText("Users")).toBeNull();
  });

  it("COMPANY_ADMIN does NOT see Companies link", () => {
    render(<Sidebar role="COMPANY_ADMIN" />);
    expect(screen.queryByText("Companies")).toBeNull();
  });
});
