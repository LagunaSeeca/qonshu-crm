import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { ServiceFees } from "./ServiceFees";

const data = { fees: [], totalBilled: 0, totalPaid: 0, totalOutstanding: 0 };

describe("ServiceFees rate editor", () => {
  it("hides the rate editor and add-fee form from non-owners, even admins", () => {
    render(<ServiceFees accountId="a1" isAdmin initialData={data} />);
    expect(screen.queryByLabelText(/rate per month/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Add Service Fee")).not.toBeInTheDocument();
  });

  it("owner saves the rate as a string, never a number", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ accountId: "a1", monthlyServiceFee: "120.50" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ServiceFees accountId="a1" isAdmin canPrice initialRate={null} initialData={data} />);
    expect(screen.getByText(/no rate set/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/rate per month/i), { target: { value: "120.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ monthlyServiceFee: "120.50" }));
    await waitFor(() => expect(screen.getByText(/currently/i)).toHaveTextContent("₼120.50"));
  });
});
