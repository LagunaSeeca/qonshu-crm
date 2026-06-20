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
      stages={[{ id: "s1", name: "New" }, { id: "s2", name: "Won" }]}
      leads={[{ id: "l1", title: "Deal A", stageId: "s1", value: 100, contactName: "J" }]}
    />);
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Won")).toBeInTheDocument();
    expect(screen.getByText("Deal A")).toBeInTheDocument();
  });
});
