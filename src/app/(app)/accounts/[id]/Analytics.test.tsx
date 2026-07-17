import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { Analytics } from "./Analytics";

const data = {
  kpis: { activeUsers: 5, totalUsers: 8, totalDebt: 1200, paymentsCount: 40, paymentsAmount: 9000, utilityCount: 10, utilityAmount: 2000 },
  byMethod: [] as { method: string; count: number; amount: number }[],
  byCategory: [] as { category: string; count: number; amount: number }[],
  trend: [] as { date: string; count: number; amount: number }[],
  topUsers: [] as { name: string; paid: number; debt: number }[],
  installs: { total: 10, ios: 6, android: 4, activated: 7, activationRate: 70 },
};

describe("Analytics", () => {
  it("renders KPI tiles from initialData", () => {
    render(<Analytics accountId="a1" initialData={data} />);
    expect(screen.getByText(/active users/i)).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders empty states for trend and breakdowns without crashing", () => {
    render(<Analytics accountId="a1" initialData={data} />);
    expect(screen.getAllByText(/no data for this range/i).length).toBeGreaterThan(0);
  });

  it("renders installs & activation tiles from initialData", () => {
    render(<Analytics accountId="a1" initialData={data} />);
    expect(screen.getByText(/installs & activation/i)).toBeInTheDocument();
    expect(screen.getByText(/total installs/i)).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText(/activation rate/i)).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
  });
});
