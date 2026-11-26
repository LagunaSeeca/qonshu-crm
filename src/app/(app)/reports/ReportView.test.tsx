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
    partners: { accounts: 2, activeAccounts: 2, appUsers: 24, activeAppUsers: 20, uniquePayingUsers: 15, engagedUsers: 18, paymentsAmount: 30000, appInstalls: 22, installsIos: 13, installsAndroid: 9 },
    finance: { collected: 16400, transferred: 8000, owed: 8400, serviceFeesOutstanding: 1200 },
  },
  partnerRows: [{ accountId: "a1", accountName: "Acme", paymentsCount: 60, paymentsAmount: 15000, collected: 8200, transferred: 4000, owed: 4200 }],
};
// A MEMBER payload: the service omits the cash figures and `payments` entirely (not 0).
const memberReport = {
  ...report,
  kpis: {
    ...report.kpis,
    finance: { serviceFeesOutstanding: 1200 },
  },
  partnerRows: [{ accountId: "a1", accountName: "Acme", paymentsCount: 60, paymentsAmount: 15000 }],
};
describe("ReportView", () => {
  it("renders period label, KPIs and partner rows", () => {
    render(<ReportView accounts={[]} initialReport={report} />);
    expect(screen.getByText("July 2026")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });
  it("shows AZN, not USD", () => {
    render(<ReportView accounts={[]} initialReport={report} />);
    expect(screen.getAllByText(/₼/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });
  it("member payload renders without cash figures or a payments table", () => {
    render(<ReportView accounts={[]} initialReport={memberReport} />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    for (const label of ["Collected", "Transferred", "Owed"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // Header and body column counts agree: Partner, Payments, Payments Amount only.
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getAllByRole("row")[1].querySelectorAll("td")).toHaveLength(3);
    // Billing data is not settlement data and stays.
    expect(screen.getByText("Service fees outstanding")).toBeInTheDocument();
    // No payment-detail table: the only table is the partner table.
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });
  it("SELF row shows n/a + badge for Owed, never 'unknown'; QONSHU absent owed stays 'unknown'", () => {
    const r = {
      ...report,
      kpis: { ...report.kpis, finance: { ...report.kpis.finance, selfCollected: 9000 } },
      partnerRows: [
        { accountId: "s1", accountName: "SelfBuilding", paymentsCount: 1, paymentsAmount: 100, collected: 0, transferred: 0, collectionMode: "SELF" as const },
        { accountId: "q1", accountName: "QonshuBuilding", paymentsCount: 1, paymentsAmount: 100, collected: 0, transferred: 0, collectionMode: "QONSHU" as const },
      ],
    };
    render(<ReportView accounts={[]} initialReport={r} />);
    expect(screen.getByText("Self-collecting")).toBeInTheDocument();
    expect(screen.getAllByText("n/a")).toHaveLength(1);
    // Only the QONSHU row's missing owed is "unknown" (Owed cell); SELF row never is.
    const selfRow = screen.getByText("SelfBuilding").closest("tr")!;
    expect(selfRow.textContent).not.toMatch(/unknown/);
    const qRow = screen.getByText("QonshuBuilding").closest("tr")!;
    expect(qRow.textContent).toMatch(/unknown/);
  });
  it("labels Collected as Qonshu-held and shows self-collected separately only when > 0", () => {
    const { unmount } = render(<ReportView accounts={[]} initialReport={report} />);
    expect(screen.getAllByText("Collected (Qonshu-held)").length).toBeGreaterThan(0);
    expect(screen.queryByText(/self-collecting buildings/)).not.toBeInTheDocument();
    unmount();
    const r = { ...report, kpis: { ...report.kpis, finance: { ...report.kpis.finance, selfCollected: 9000 } } };
    render(<ReportView accounts={[]} initialReport={r} />);
    expect(screen.getByText(/Collected by self-collecting buildings/)).toBeInTheDocument();
  });
});
