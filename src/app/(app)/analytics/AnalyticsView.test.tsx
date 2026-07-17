import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { AnalyticsView } from "./AnalyticsView";

const data = {
  totals: {
    accounts: 2,
    appUsers: 24,
    activeUsers: 20,
    engagedUsers: 18,
    totalDebt: 1200,
    installs: 22,
    iosInstalls: 13,
    androidInstalls: 9,
    loggedInUsers: 16,
    activationRate: 72.7,
    paymentsCount: 40,
    paymentsAmount: 30000,
    utilityCount: 10,
    utilityAmount: 2000,
  },
  byMethod: [] as { method: string; count: number; amount: number }[],
  byCategory: [] as { category: string; count: number; amount: number }[],
  trend: [] as { date: string; count: number; amount: number }[],
  partners: [
    { accountId: "a1", accountName: "Acme Partner", appUsers: 15, installs: 14, engagedUsers: 10, paymentsCount: 25, paymentsAmount: 18000 },
  ],
};

describe("AnalyticsView", () => {
  it("renders a KPI label/value from initialData", () => {
    render(<AnalyticsView initialData={data} initialPeriod="MONTHLY" />);
    expect(screen.getByText(/partner accounts/i)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders a partner row from initialData, linked to the account", () => {
    render(<AnalyticsView initialData={data} initialPeriod="MONTHLY" />);
    const link = screen.getByRole("link", { name: /acme partner/i });
    expect(link).toHaveAttribute("href", "/accounts/a1");
  });

  it("renders empty states for trend and breakdowns without crashing", () => {
    render(<AnalyticsView initialData={data} initialPeriod="MONTHLY" />);
    expect(screen.getAllByText(/no data for this range/i).length).toBeGreaterThan(0);
  });

  it("shows an empty state when the company has no accounts", () => {
    const empty = { ...data, totals: { ...data.totals, accounts: 0 }, partners: [] };
    render(<AnalyticsView initialData={empty} initialPeriod="MONTHLY" />);
    expect(screen.getByText(/no partner accounts yet/i)).toBeInTheDocument();
  });
});
