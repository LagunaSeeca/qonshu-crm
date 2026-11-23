import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
import { AccountDetail } from "./AccountDetail";

const base = {
  account: { id: "a1", name: "Partner Co", status: "ACTIVE", website: "", industry: "SaaS", accountManagerId: "u", primaryContactName: "Jane", primaryContactEmail: "", primaryContactPhone: "", externalPartnerKey: null, partnerLinkPending: false },
  members: [{ id: "u", name: "M1" }],
  activities: [{ id: "ac1", kind: "MEETING", body: "kickoff call", outcome: null, occurredAt: new Date().toISOString(), authorId: "u" }],
  tasks: [{ id: "t1", title: "send deck", dueDate: null, done: false }],
  asks: [{ id: "k1", title: "need API key", detail: null, status: "OPEN", createdAt: new Date().toISOString(), resolvedAt: null }],
  attachments: [{ id: "f1", filename: "msa.pdf", size: 10, mime: "application/pdf" }],
};

// AccountDetail renders sibling components (AccountFields, Analytics, …) that fetch their own
// data on mount — every panel stays in the DOM. Unmocked, those calls just reject (relative URLs
// can't be parsed outside a browser) and each component already handles that gracefully, which
// is why these tests need no fetch mock at all. This spy exists only to prove that AccountDetail
// itself no longer reaches for /api/partners: that endpoint is SUPER_ADMIN-only now, so a
// COMPANY_ADMIN loading this page would just get a 403.
function fetchSpy() {
  return vi.fn((input: string | URL | Request) => Promise.reject(new Error(`not mocked: ${String(input)}`)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountDetail", () => {
  it("renders account, activity, task, ask, attachment", () => {
    render(<AccountDetail {...base} />);
    expect(screen.getByText("Partner Co")).toBeInTheDocument();
    expect(screen.getByText("kickoff call")).toBeInTheDocument();
    expect(screen.getByText("send deck")).toBeInTheDocument();
    expect(screen.getByText("need API key")).toBeInTheDocument();
    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
  });

  it("shows the linked partner READ-ONLY — no editable control, no picker", () => {
    render(<AccountDetail {...base} account={{ ...base.account, externalPartnerKey: "Komplex B" }} />);
    expect(screen.getByText("Analytics partner link")).toBeInTheDocument();
    expect(screen.getByText("Komplex B")).toBeInTheDocument();
    expect(screen.getByText(/confirmed by the owner/i)).toBeInTheDocument();
    // The name must not be inside any form control a company user could change.
    const editable = screen
      .queryAllByRole("textbox")
      .concat(screen.queryAllByRole("combobox"))
      .filter((el) => (el as HTMLInputElement).value === "Komplex B");
    expect(editable).toEqual([]);
  });

  it("shows a clear 'not linked yet' state when the account has no partner", () => {
    render(<AccountDetail {...base} />);
    expect(screen.getByText("Not linked yet")).toBeInTheDocument();
  });

  // A PENDING link must not read as a link. The key is in the row from the moment the building is
  // named, but it authorizes nothing until an admin confirms it on /partner-links — showing the
  // complex name here would make an empty Analytics tab look like a bug instead of a gate.
  it("reports a PENDING link as awaiting confirmation, and never prints the proposed complex", () => {
    render(
      <AccountDetail
        {...base}
        account={{ ...base.account, externalPartnerKey: null, partnerLinkPending: true }}
      />,
    );
    expect(screen.getByText(/awaiting owner confirmation/i)).toBeInTheDocument();
    expect(screen.queryByText("Not linked yet")).not.toBeInTheDocument();
  });

  it("never calls the SUPER_ADMIN-only /api/partners endpoint", () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy);
    render(<AccountDetail {...base} account={{ ...base.account, externalPartnerKey: "Komplex B" }} />);
    const partnerCalls = spy.mock.calls.filter(([input]) => String(input).includes("/api/partners"));
    expect(partnerCalls).toEqual([]);
  });
});
