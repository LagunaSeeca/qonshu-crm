import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { Settlement } from "./Settlement";

const data = {
  status: "ok" as const,
  collected: 800,
  transferred: 200,
  remaining: 600,
  transferredByMethod: { CASH: 200, BANK_TRANSFER: 0, MANUAL: 0 },
  transfers: [
    // Prisma Decimal / Date arrive over JSON as strings.
    { id: "e1", amount: "200", method: "CASH" as const, occurredAt: new Date().toISOString(), note: "june" },
  ],
};
// Service omits collected/remaining entirely when the upstream is unavailable.
const { collected: _c, remaining: _r, ...omitMoney } = data;
describe("Settlement", () => {
  it("renders balances + the transfer ledger from `transfers`", () => {
    render(<Settlement accountId="a1" canWrite initialData={data} />);
    expect(screen.getByText(/remaining/i)).toBeInTheDocument();
    expect(screen.getByText("june")).toBeInTheDocument();
    expect(screen.queryByText(/no transfers recorded/i)).not.toBeInTheDocument();
  });

  it("does not render a Collected by-method breakdown", () => {
    render(<Settlement accountId="a1" initialData={data} />);
    // Cash/Bank/Manual appear once each, under Transferred only.
    expect(screen.getAllByText("Manual")).toHaveLength(1);
  });

  it("shows the status, not a fabricated figure, when Collected is unavailable", () => {
    render(<Settlement accountId="a1" initialData={{ ...omitMoney, status: "unavailable" as const }} />);
    expect(screen.getByText(/partner api unavailable/i)).toBeInTheDocument();
  });
});
