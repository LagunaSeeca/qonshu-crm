import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { ReportView } from "./ReportView";
const report = {
  label: "July 2026",
  scope: "ALL",
  kpis: {
    sales: { openLeads: 3, wonInPeriod: 1 },
    activity: { meetingsDone: 4, openTasks: 5, overdueTasks: 2 },
    partners: { accounts: 2, activeAccounts: 2, appUsers: 24, activeAppUsers: 20, engagedUsers: 18, paymentsAmount: 30000 },
    finance: { collected: 16400, transferred: 8000, owed: 8400 },
  },
  partnerRows: [{ accountId: "a1", accountName: "Acme", paymentsCount: 60, paymentsAmount: 15000, collected: 8200, transferred: 4000, owed: 4200 }],
};
describe("ReportView", () => {
  it("renders period label, KPIs and partner rows", () => {
    render(<ReportView accounts={[]} initialReport={report} />);
    expect(screen.getByText("July 2026")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });
});
