import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { Settlement } from "./Settlement";
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { toast } from "sonner";

const data = {
  status: "ok" as const,
  // AccountSettlement now carries who holds the building's money; QONSHU is the default and what
  // these existing cases have always meant.
  collectionMode: "QONSHU" as const,
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

  describe("self-collecting", () => {
    // Service omits remaining (and owed) for SELF; collected may be present.
    const { remaining: _rem, ...selfBase } = data;
    const self = { ...selfBase, collectionMode: "SELF" as const };

    it("shows the badge and n/a, never a fabricated remaining, and hides add-transfer", () => {
      render(<Settlement accountId="a1" canWrite initialData={self} />);
      expect(screen.getAllByText("Self-collecting").length).toBeGreaterThan(0);
      // EXACTLY ONE "n/a": Remaining. Transferred must NOT be n/a — the service returns it for a
      // SELF building because transfer rows are real history (a building may have been settled
      // through Qonshu before it switched), and the Transfers table below lists them. Marking the
      // card "n/a" above its own populated table contradicted itself.
      expect(screen.getAllByText("n/a")).toHaveLength(1);
      // transferred = 200, and its real figure is rendered rather than suppressed.
      expect(screen.getAllByText(/\b200/).length).toBeGreaterThan(0);
      expect(screen.getByText(/\b800/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add transfer/i })).not.toBeInTheDocument();
      expect(screen.queryByText("Add Transfer")).not.toBeInTheDocument();
    });

    it("shows the collection-mode toggle only when the viewer can write", () => {
      const { unmount } = render(<Settlement accountId="a1" initialData={data} />);
      expect(screen.queryByLabelText(/collection mode/i)).not.toBeInTheDocument();
      unmount();
      render(<Settlement accountId="a1" canWrite initialData={data} />);
      expect(screen.getByText(/collection mode/i)).toBeInTheDocument();
    });

    it("handles a 422 self_collecting race with a clear message", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ error: "self_collecting", message: "x" }) })
        .mockResolvedValue({ ok: true, status: 200, json: async () => self });
      vi.stubGlobal("fetch", fetchMock);
      render(<Settlement accountId="a1" canWrite initialData={data} />);
      fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "5" } });
      fireEvent.click(screen.getByRole("button", { name: /add transfer/i }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/collects its own money/i)),
      );
      vi.unstubAllGlobals();
    });
  });
});
