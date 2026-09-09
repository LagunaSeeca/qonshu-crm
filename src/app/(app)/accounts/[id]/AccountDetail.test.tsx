import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
import { AccountDetail } from "./AccountDetail";

const base = {
  account: { id: "a1", name: "Partner Co", status: "ACTIVE", website: "", industry: "SaaS", accountManagerId: "u", primaryContactName: "Jane", primaryContactEmail: "", primaryContactPhone: "", externalPartnerKey: null },
  members: [{ id: "u", name: "M1" }],
  activities: [{ id: "ac1", kind: "MEETING", body: "kickoff call", outcome: null, occurredAt: new Date().toISOString(), authorId: "u" }],
  tasks: [{ id: "t1", title: "send deck", dueDate: null, done: false }],
  asks: [{ id: "k1", title: "need API key", detail: null, status: "OPEN", createdAt: new Date().toISOString(), resolvedAt: null }],
  attachments: [{ id: "f1", filename: "msa.pdf", size: 10, mime: "application/pdf" }],
};

const partners = [
  { name: "Komplex B", type: "RESIDENTIAL" },
  { name: "Sabah.City", type: "COMMERCIAL" },
];

// AccountDetail also renders sibling components (AccountFields, Analytics, …)
// that fetch their own data on mount — every panel stays in the DOM (see the
// "Manual tabs" comment below). Unmocked, those calls just reject (relative
// URLs can't be parsed outside a browser) and each component already handles
// that gracefully — it's how the base "renders account, activity…" test above
// passes with no fetch mock at all. So route only `/api/partners` through our
// mock and let every other URL reject the same way, instead of resolving with
// a shape those siblings don't expect (which does crash them).
function mockFetchWithPartners() {
  return vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/partners")) {
      return Promise.resolve({ ok: true, json: async () => ({ partners }) });
    }
    return Promise.reject(new Error("not mocked"));
  });
}

function mockFetchWithFailingPartners() {
  return vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/partners")) {
      return Promise.reject(new Error("network down"));
    }
    return Promise.reject(new Error("not mocked"));
  });
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

  it("preselects the account's current partner in the searchable picker", async () => {
    vi.stubGlobal("fetch", mockFetchWithPartners());
    render(<AccountDetail {...base} account={{ ...base.account, externalPartnerKey: "Komplex B" }} />);
    await waitFor(() => {
      expect(screen.getByLabelText("Partner name for analytics API")).toHaveValue("Komplex B");
    });
    expect(screen.queryByText(/not in the current partner list/i)).not.toBeInTheDocument();
  });

  it("flags a stale externalPartnerKey that is no longer in the fetched partner list", async () => {
    vi.stubGlobal("fetch", mockFetchWithPartners());
    render(<AccountDetail {...base} account={{ ...base.account, externalPartnerKey: "Old Renamed Partner" }} />);
    await waitFor(() => {
      expect(screen.getByText(/not in the current partner list/i)).toBeInTheDocument();
    });
    // The stale value is still shown, never silently wiped (the combobox input
    // plus its hidden form-submission mirror both carry the value; assert on
    // the visible, labelled one).
    expect(screen.getByLabelText("Partner name for analytics API")).toHaveValue("Old Renamed Partner");
  });

  it("falls back to a plain text input when the partner list fails to load", async () => {
    vi.stubGlobal("fetch", mockFetchWithFailingPartners());
    render(<AccountDetail {...base} account={{ ...base.account, externalPartnerKey: "Komplex B" }} />);
    await waitFor(() => {
      expect(screen.getByText(/couldn.?t load the partner list/i)).toBeInTheDocument();
    });
    // Still editable and pre-filled — never blocks saving.
    const input = screen.getByLabelText("Partner name for analytics API");
    expect(input).toHaveValue("Komplex B");
    expect(input).not.toBeDisabled();
  });
});
