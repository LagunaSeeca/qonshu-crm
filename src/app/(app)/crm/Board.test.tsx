import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Board, moveResultToast } from "./Board";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => ({ get: () => null }),
}));

describe("Board", () => {
  it("renders a column per stage and cards in them", () => {
    render(<Board
      stages={[{ id: "s1", name: "New", probability: 10, type: "OPEN" }, { id: "s2", name: "Won", probability: 100, type: "WON" }]}
      leads={[{ id: "l1", title: "Deal A", stageId: "s1", contactName: "J" }]}
    />);
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Won")).toBeInTheDocument();
    expect(screen.getByText("Deal A")).toBeInTheDocument();
  });

  it("exposes a link to the lead detail page on each card, so a click opens the lead", () => {
    render(<Board
      stages={[{ id: "s1", name: "New", probability: 10, type: "OPEN" }]}
      leads={[{ id: "l1", title: "Deal A", stageId: "s1", contactName: "J" }]}
    />);
    const link = screen.getByRole("link", { name: /deal a/i });
    expect(link).toHaveAttribute("href", "/crm/l1");
  });
});

// moveResultToast drives the post-drag toast: a failed auto-conversion on a Won move must never
// read as an unqualified success (see moveLeadStage in src/lib/tenant/leads.ts, which swallows
// that failure server-side so the stage move still stands).
describe("moveResultToast", () => {
  it("returns null for a move into a non-Won stage, preserving the existing silent-success behavior", () => {
    expect(moveResultToast({ type: "OPEN" }, false)).toBeNull();
    expect(moveResultToast({ type: "LOST" }, false)).toBeNull();
    expect(moveResultToast(undefined, false)).toBeNull();
  });

  it("returns a success outcome for a Won move that auto-converted", () => {
    const outcome = moveResultToast({ type: "WON" }, true);
    expect(outcome).not.toBeNull();
    expect(outcome!.variant).toBe("success");
  });

  it("returns a warning outcome (not success) for a Won move whose auto-conversion failed", () => {
    const outcome = moveResultToast({ type: "WON" }, false);
    expect(outcome).not.toBeNull();
    expect(outcome!.variant).toBe("warning");
    expect(outcome!.message.toLowerCase()).toContain("convert to account");
  });
});
