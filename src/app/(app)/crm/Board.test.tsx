import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Board } from "./Board";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => ({ get: () => null }),
}));

describe("Board", () => {
  it("renders a column per stage and cards in them", () => {
    render(<Board
      stages={[{ id: "s1", name: "New", probability: 10 }, { id: "s2", name: "Won", probability: 100 }]}
      leads={[{ id: "l1", title: "Deal A", stageId: "s1", contactName: "J" }]}
    />);
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Won")).toBeInTheDocument();
    expect(screen.getByText("Deal A")).toBeInTheDocument();
  });

  it("exposes a link to the lead detail page on each card, so a click opens the lead", () => {
    render(<Board
      stages={[{ id: "s1", name: "New", probability: 10 }]}
      leads={[{ id: "l1", title: "Deal A", stageId: "s1", contactName: "J" }]}
    />);
    const link = screen.getByRole("link", { name: /deal a/i });
    expect(link).toHaveAttribute("href", "/crm/l1");
  });
});
