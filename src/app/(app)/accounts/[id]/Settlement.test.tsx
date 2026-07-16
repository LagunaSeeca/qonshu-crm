import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { Settlement } from "./Settlement";

const data = {
  collected: 800,
  transferred: 200,
  owed: 600,
  collectedByMethod: { CASH: 500, BANK_TRANSFER: 300, MANUAL: 0 },
  transferredByMethod: { CASH: 200, BANK_TRANSFER: 0, MANUAL: 0 },
  entries: [{ id: "e1", type: "COLLECTED", amount: 800, method: "CASH", occurredAt: new Date().toISOString(), note: "june", createdById: "u" }],
};
describe("Settlement", () => {
  it("renders balances + registry", () => {
    render(<Settlement accountId="a1" isAdmin initialData={data} />);
    expect(screen.getByText(/owed/i)).toBeInTheDocument();
    expect(screen.getByText("june")).toBeInTheDocument();
  });
});
