import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Objects } from "./Objects";

const totals = { buildings: 3, blocks: 5, apartments: 120, parkings: 40, properties: 7, offices: 2 };

function mockBody(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}
afterEach(() => vi.unstubAllGlobals());

describe("Objects", () => {
  // Regression: a MEMBER receives { detail: "summary" } with NO `buildings` key; the tab used to
  // call buildings.map on undefined and white-screen the whole account page.
  it("renders totals for a member-shaped summary payload without crashing", async () => {
    mockBody({ status: "ok", detail: "summary", partner: "Acme", complexType: "RESIDENTIAL", totals });
    render(<Objects accountId="a1" />);
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("Apartments")).toBeInTheDocument();
    expect(screen.queryByText("No buildings")).not.toBeInTheDocument();
  });

  it("renders the per-building tree for a full payload", async () => {
    mockBody({
      status: "ok",
      detail: "full",
      partner: "Acme",
      complexType: "RESIDENTIAL",
      totals,
      buildings: [{ id: 1, name: "Tower A", blocks: [], parkings: [], properties: [], offices: [] }],
    });
    render(<Objects accountId="a1" />);
    expect(await screen.findByText("Tower A")).toBeInTheDocument();
    expect(screen.getByText("Apartments")).toBeInTheDocument();
  });
});
