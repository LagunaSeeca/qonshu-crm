import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { Settlement } from "./Settlement";

const data = { collected: 800, transferred: 200, owed: 600, entries: [{ id: "e1", type: "COLLECTED", amount: 800, method: null, occurredAt: new Date().toISOString(), note: "june", createdById: "u" }] };
describe("Settlement", () => {
  it("renders balances + registry", () => {
    render(<Settlement accountId="a1" isAdmin initialData={data} />);
    expect(screen.getByText(/owed/i)).toBeInTheDocument();
    expect(screen.getByText("june")).toBeInTheDocument();
  });
});
