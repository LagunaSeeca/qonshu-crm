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
  moneyFlow: [] as { date: string; paymentsIn: number; collected: number; transferred: number }[],
  debtOverTime: [] as { date: string; debt: number }[],
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

  it("renders the partner name as plain text (no dead account link) for partner logins", () => {
    render(<AnalyticsView initialData={data} initialPeriod="MONTHLY" isPartner />);
    expect(screen.queryByRole("link", { name: /acme partner/i })).toBeNull();
    expect(screen.getAllByText("Acme Partner").length).toBeGreaterThan(0);
  });

  it("renders empty states for breakdowns without crashing", () => {
    render(<AnalyticsView initialData={data} initialPeriod="MONTHLY" />);
    expect(screen.getAllByText(/no data for this range/i).length).toBeGreaterThan(0);
  });

  it("renders the money-flow empty state and a legend for all three series once there's data", () => {
    render(<AnalyticsView initialData={data} initialPeriod="MONTHLY" />);
    expect(screen.getByText(/no activity in this range/i)).toBeInTheDocument();

    const withFlow = {
      ...data,
      moneyFlow: [
        { date: "2026-07-01", paymentsIn: 100, collected: 60, transferred: 20 },
        { date: "2026-07-02", paymentsIn: 50, collected: 0, transferred: 10 },
      ],
    };
    render(<AnalyticsView initialData={withFlow} initialPeriod="MONTHLY" />);
    // May also appear as a direct on-chart label when it doesn't collide with a neighbor,
    // so assert presence rather than a single match.
    expect(screen.getAllByText("App payments in").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Collected to bank").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cash transferred out").length).toBeGreaterThan(0);
  });

  it("shows the debt-over-time empty state with no snapshots, and current/peak once there's data", () => {
    render(<AnalyticsView initialData={data} initialPeriod="MONTHLY" />);
    expect(screen.getByText(/no debt recorded in this range/i)).toBeInTheDocument();

    const withDebt = {
      ...data,
      debtOverTime: [
        { date: "2026-07-01", debt: 800 },
        { date: "2026-07-15", debt: 1200 },
      ],
    };
    render(<AnalyticsView initialData={withDebt} initialPeriod="MONTHLY" />);
    expect(screen.getAllByText("Debt Over Time").length).toBeGreaterThan(0);
    expect(screen.getByText("Peak in range")).toBeInTheDocument();
    expect(screen.getAllByText("$1,200").length).toBeGreaterThan(0); // peak + current label
  });

  it("shows an empty state when the company has no accounts", () => {
    const empty = { ...data, totals: { ...data.totals, accounts: 0 }, partners: [] };
    render(<AnalyticsView initialData={empty} initialPeriod="MONTHLY" />);
    expect(screen.getByText(/no partner accounts yet/i)).toBeInTheDocument();
  });
});
