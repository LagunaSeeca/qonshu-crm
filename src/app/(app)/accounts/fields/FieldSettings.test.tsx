import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FieldSettings } from "./FieldSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

describe("FieldSettings", () => {
  it("renders field defs and the add-field form", () => {
    render(<FieldSettings initialDefs={[{ id: "d1", label: "Total area", type: "NUMBER", order: 0 }]} />);
    expect(screen.getByText("Total area")).toBeInTheDocument();
    expect(screen.getByLabelText(/label/i)).toBeInTheDocument();
  });

  it("shows empty state when there are no fields", () => {
    render(<FieldSettings initialDefs={[]} />);
    expect(screen.getByText(/no custom fields yet/i)).toBeInTheDocument();
  });
});
