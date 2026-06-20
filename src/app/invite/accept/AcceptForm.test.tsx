import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AcceptForm } from "./AcceptForm";

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => "tok" }),
}));

describe("AcceptForm", () => {
  it("renders name input, password input, and submit button", () => {
    render(<AcceptForm />);
    expect(screen.getByPlaceholderText("Your name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password (min 8)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });

  it("renders the Accept invitation heading", () => {
    render(<AcceptForm />);
    expect(screen.getByText("Accept invitation")).toBeInTheDocument();
  });
});
