import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageSettings } from "./StageSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

describe("StageSettings", () => {
  it("renders stages and the visibility toggle", () => {
    render(<StageSettings initialStages={[{ id: "s1", name: "New", type: "OPEN", probability: 10, order: 0 }]} shareAllLeads={true} />);
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByLabelText(/share all leads/i)).toBeInTheDocument();
  });
});
