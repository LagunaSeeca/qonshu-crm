import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
  usePathname: () => "/service-fees",
  useSearchParams: () => new URLSearchParams("period=last-month&status=OVERDUE"),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { ServiceFeesView } from "./ServiceFeesView";

const totals = { billed: 300, paid: 100, outstanding: 200, overdue: 150 };
const rows = [
  { accountId: "a", accountName: "Alpha", monthlyServiceFee: "120.50", billed: 100, paid: 0, outstanding: 100, overdue: 100 },
  { accountId: "b", accountName: "Beta", monthlyServiceFee: null, billed: 200, paid: 100, outstanding: 100, overdue: 50 },
];

beforeEach(() => vi.restoreAllMocks());

describe("ServiceFeesView", () => {
  it("shows the rate, a visible 'Not set' for no rate, and the overdue amount", () => {
    render(<ServiceFeesView totals={totals} rows={rows} defaultMonth="2026-11" />);
    expect(screen.getByText("₼120.50")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getAllByText("Overdue")).toHaveLength(2); // tile + column
    expect(screen.getByText("₼150")).toBeInTheDocument(); // totals.overdue
  });

  it("sort links keep the other filters and flip the active direction", () => {
    render(<ServiceFeesView totals={totals} rows={rows} sortKey="billed" sortDir="desc" defaultMonth="2026-11" />);
    const link = screen.getByRole("link", { name: /^Billed/ });
    const href = link.getAttribute("href")!;
    expect(href).toContain("period=last-month");
    expect(href).toContain("status=OVERDUE");
    expect(href).toContain("sort=billed");
    expect(href).toContain("dir=asc");
    expect(link.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("hides Generate from non-owners", () => {
    render(<ServiceFeesView totals={totals} rows={rows} defaultMonth="2026-11" />);
    expect(screen.queryByRole("button", { name: /generate fees/i })).not.toBeInTheDocument();
  });

  it("owner generates and sees created/skipped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ created: 4, skipped: 2 }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ServiceFeesView totals={totals} rows={rows} canPrice defaultMonth="2026-11" />);
    fireEvent.click(screen.getByRole("button", { name: "Generate fees for November 2026" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("created 4, skipped 2 (already billed)"));
    expect(fetchMock).toHaveBeenCalledWith("/api/service-fees/generate", expect.objectContaining({ body: JSON.stringify({ month: "2026-11" }) }));
  });
});
