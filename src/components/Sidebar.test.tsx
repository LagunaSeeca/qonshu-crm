import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("shows Users link for admins only", () => {
    const { rerender } = render(<Sidebar role="MEMBER" />);
    expect(screen.queryByText("Users")).toBeNull();
    rerender(<Sidebar role="COMPANY_ADMIN" />);
    expect(screen.getByText("Users")).toBeInTheDocument();
  });

  it("shows Teams and Partner links for SUPER_ADMIN, and Users too", () => {
    render(<Sidebar role="SUPER_ADMIN" />);
    expect(screen.getByText("Teams")).toBeInTheDocument();
    expect(screen.getByText("Partner links")).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.queryByText("Companies")).toBeNull();
  });

  it("COMPANY_ADMIN sees Users but not Teams or Partner links", () => {
    render(<Sidebar role="COMPANY_ADMIN" />);
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.queryByText("Teams")).toBeNull();
    expect(screen.queryByText("Partner links")).toBeNull();
  });

  it("labels COMPANY_ADMIN as Team Admin and shows the team name in the footer", () => {
    render(<Sidebar role="COMPANY_ADMIN" companyName="Acme Co" teamName="Baku Sales" />);
    expect(screen.getByText("Team Admin")).toBeInTheDocument();
    expect(screen.getByText("Baku Sales")).toBeInTheDocument();
    expect(screen.queryByText("Acme Co")).toBeNull();
  });

  it("PARTNER_VIEWER sees only Analytics, Settlements, Service fees", () => {
    render(<Sidebar role="PARTNER_VIEWER" />);
    expect(screen.getByText("Analytics")).toBeInTheDocument();
    expect(screen.getByText("Settlements")).toBeInTheDocument();
    expect(screen.getByText("Service fees")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).toBeNull();
    expect(screen.queryByText("My Work")).toBeNull();
    expect(screen.queryByText("Sales CRM")).toBeNull();
    expect(screen.queryByText("Accounts")).toBeNull();
    expect(screen.queryByText("Reports")).toBeNull();
    expect(screen.queryByText("Users")).toBeNull();
  });

  it("PARTNER_VIEWER footer shows Partner badge", () => {
    render(<Sidebar role="PARTNER_VIEWER" companyName="Demo Co" />);
    expect(screen.getByText("Partner")).toBeInTheDocument();
  });
});
