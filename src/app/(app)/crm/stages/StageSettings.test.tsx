import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageSettings } from "./StageSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

describe("StageSettings", () => {
  it("renders stages and no visibility toggle (member isolation is absolute)", () => {
    render(<StageSettings initialStages={[{ id: "s1", name: "New", type: "OPEN", probability: 10, order: 0 }]} />);
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.queryByLabelText(/share all leads/i)).toBeNull();
    expect(screen.queryByText(/lead visibility/i)).toBeNull();
  });
});

describe("StageSettings template mode", () => {
  it("warns that editing the default template only affects teams created later", () => {
    render(<StageSettings initialStages={[]} isTemplate scopeQuery="?teamId=" />);
    expect(screen.getByText(/default template/i, { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/only to teams created later/i)).toBeInTheDocument();
  });
});
