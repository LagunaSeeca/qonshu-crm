import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeTeamWithUsers, makeUser, su, buildingKey } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";
import type { PartnerListResponse, PartnerObjectsResponse } from "@/lib/partner-api/schema";
import { makePartnerStats } from "@/test/partner-stats-fixture";

// F1: REMOVING THE ALLOWLIST SWAPPED AN ENTITLEMENT CHECK FOR A CONTENTION CHECK.
//
// "Has anyone here claimed this building?" is not "may Qonshu read this complex's data at all?".
// With auto-link resolving straight off the live upstream list, a plain MEMBER who guessed or
// overheard a building name created an account, auto-linked it, and read that complex's debt,
// payments and — via the Objects tab — every unit's owner name and phone, for buildings Qonshu
// has no contract with.
//
// The fix: naming a building still records a link, but the link is PENDING and grants NOTHING
// until an admin confirms it — the account team's own admin, or the owner, and never the person
// who proposed it. These tests pin all of that: pending yields no partner data on ANY surface,
// confirming is what turns the data on, and who may confirm is its own describe below.
vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => mockUser }));

vi.mock("@/lib/partner-api/client", () => ({
  fetchPartners: vi.fn(),
  fetchPartnerStats: vi.fn(),
  fetchPartnerObjects: vi.fn(),
}));

import { fetchPartners, fetchPartnerStats, fetchPartnerObjects } from "@/lib/partner-api/client";
import { createAccount, updateAccount } from "./accounts";
import { getAccountAnalytics, listAccountPayments } from "./partner-analytics";
import { getCompanyAnalytics } from "./company-analytics";
import { getReport } from "./reports";
import { getDashboardStats } from "./dashboard";
import { BuildingClaimedError } from "./building-claim";
import { ForbiddenError } from "@/lib/auth/guards";
import {
  confirmPartnerLink,
  rejectPartnerLink,
  listPendingPartnerLinks,
  NoPendingPartnerLinkError,
  SelfApprovalError,
} from "./partner-link-approval";
import {
  setAccountPartner,
  UnknownPartnerNameError,
  PartnerListUnavailableError,
} from "@/lib/platform/account-partners";
import { NotFoundError } from "@/lib/auth/guards";
import { GET as objectsGET } from "@/app/api/accounts/[id]/objects/route";

const SHARED_API_KEY = "sk_live_approval";
const range = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T23:59:59Z") };

function partners(...names: string[]): PartnerListResponse {
  return { partners: names.map((name) => ({ name, type: "RESIDENTIAL" as const })) };
}

function rawObjects(): PartnerObjectsResponse {
  return {
    partner: "Komplex B",
    complex_type: "RESIDENTIAL",
    buildings: [
      {
        id: 1,
        name: "Building A",
        blocks: [
          {
            id: 10,
            name: "Block 1",
            apartments: [
              { id: 100, owner_id: 5, owner_name: "Jane", owner_mobile: "+100", debt: 50, balance: 10, net: -40, apartment_number: "12B" },
            ],
          },
        ],
        parkings: [],
        properties: [],
        offices: [],
      },
    ],
  };
}

let savedApiKey: string | undefined;

async function prepare() {
  await resetDb();
  savedApiKey = process.env.PARTNER_API_KEY;
  process.env.PARTNER_API_KEY = SHARED_API_KEY;
  vi.mocked(fetchPartners).mockReset();
  vi.mocked(fetchPartners).mockResolvedValue(partners());
  vi.mocked(fetchPartnerStats).mockReset();
  vi.mocked(fetchPartnerStats).mockResolvedValue(makePartnerStats({ total_debt: 999, total_users: 7 }));
  vi.mocked(fetchPartnerObjects).mockReset();
  vi.mocked(fetchPartnerObjects).mockResolvedValue(rawObjects());
  mockUser = null;
}

function restore() {
  if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
  else process.env.PARTNER_API_KEY = savedApiKey;
  mockUser = null;
}

describe("a PENDING partner link grants no partner data on any surface", () => {
  beforeEach(prepare);
  afterEach(restore);
  afterAll(() => testPrisma.$disconnect());

  it("a MEMBER who names a real upstream complex reads nothing from it until it is confirmed", async () => {
    // "Komplex B" is a real complex upstream. Under the F1 behaviour, naming it auto-linked the
    // account and every surface below answered with that complex's data.
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });

    // 1. The account Analytics tab.
    const analytics = await getAccountAnalytics(testPrisma, t.suMember, acc.id, range);
    expect(analytics.status).toBe("not-configured");
    expect(analytics.kpis.totalDebt).toBe(0);

    // 2. The payments page.
    const payments = await listAccountPayments(testPrisma, t.suMember, acc.id, range);
    expect(payments.status).toBe("not-configured");
    expect(payments.rows).toEqual([]);

    // 3. The Objects tab — the surface that carries unit-level owner names and phone numbers.
    mockUser = t.suMember;
    const res = await objectsGET(new NextRequest(`http://localhost/api/accounts/${acc.id}/objects`), {
      params: Promise.resolve({ id: acc.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_configured" });

    // 4. The company-wide analytics fan-out.
    const company = await getCompanyAnalytics(testPrisma, t.suAdmin, range);
    expect(company.accountStatuses).toEqual([
      { accountId: acc.id, accountName: acc.name, status: "skipped", reason: "not_configured" },
    ]);
    expect(company.totals.totalDebt).toBe(0);

    // 5. The reporting export.
    const report = await getReport(testPrisma, t.suAdmin, { range, label: "June" });
    expect(report.accountStatuses).toEqual([
      { accountId: acc.id, accountName: acc.name, status: "skipped", reason: "not_configured" },
    ]);
    expect(report.payments).toEqual([]);

    // Nothing in the system called the partner API for this complex at all.
    expect(fetchPartnerStats).not.toHaveBeenCalled();
    expect(fetchPartnerObjects).not.toHaveBeenCalled();

    // The claim IS recorded — that is what stops a second member pending the same building —
    // but it is not confirmed, so it authorizes nothing.
    const row = await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.externalPartnerKey).not.toBeNull();
    expect(row.partnerLinkConfirmedAt).toBeNull();
  });

  // THE DASHBOARD reads the company-analytics fan-out, so it is gated by the same chokepoint.
  // Asserted separately because it is its own entry point, and the brief asked for each consumer
  // to be verified rather than assumed.
  it("the dashboard's partner KPIs stay at zero while the link is pending", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).externalPartnerKey)
      .toBe("komplex b");

    const stats = await getDashboardStats(testPrisma, t.suAdmin, range);
    expect(stats.partners).toMatchObject({
      activeAppUsers: 0, appUsers: 0, paymentsAmount: 0, appInstalls: 0,
    });
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  // A PARTNER_VIEWER is the least-privileged role there is; their own pending account must not be
  // the way in either.
  it("a PARTNER_VIEWER on a pending account reads nothing", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    const viewer = await makeUser("PARTNER_VIEWER", t.team, { accountId: acc.id });

    const analytics = await getAccountAnalytics(testPrisma, su(viewer), acc.id, range);
    expect(analytics.status).toBe("not-configured");
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });
});

describe("the decision on a pending link", () => {
  beforeEach(prepare);
  afterEach(restore);
  afterAll(() => testPrisma.$disconnect());

  // The owner: above every team, and exempt from the two-person rule.
  async function owner() {
    return su(await makeUser("SUPER_ADMIN"));
  }

  // A SECOND admin on a team, for the common case where the proposer is the team's first admin.
  // makeTeamWithUsers gives one admin and one member; the two-person rule means a link the admin
  // proposed needs somebody else, so most tests here need this.
  async function secondAdmin(team: Parameters<typeof makeUser>[1]) {
    return su(await makeUser("COMPANY_ADMIN", team));
  }

  it("CONFIRMING grants the data, and stores the upstream's exact spelling", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "  komplex   b " });

    // The member's own TEAM ADMIN confirms it — this is the ordinary path, not an owner-only one.
    const confirmed = await confirmPartnerLink(testPrisma, t.suAdmin, acc.id);
    // The pending key was the normalized building name; confirm swaps in what the upstream calls
    // it, because `?partner=` is matched literally upstream.
    expect(confirmed.externalPartnerKey).toBe("Komplex B");
    expect(confirmed.partnerLinkConfirmedAt).toBeInstanceOf(Date);

    const analytics = await getAccountAnalytics(testPrisma, t.suMember, acc.id, range);
    expect(analytics.status).toBe("ok");
    expect(analytics.kpis.totalDebt).toBe(999);
    expect(vi.mocked(fetchPartnerStats).mock.calls[0][0]).toMatchObject({ partner: "Komplex B" });
  });

  it("CONFIRM refuses when the proposed name no longer matches exactly one live complex", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    const sa = await owner();

    // Renamed / removed upstream: zero matches.
    vi.mocked(fetchPartners).mockResolvedValue(partners("Something Else"));
    await expect(confirmPartnerLink(testPrisma, sa, acc.id)).rejects.toThrow(UnknownPartnerNameError);

    // Two upstream spellings collapsing onto one building: picking either would point the account
    // at a complex whose identity cannot be established.
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B", "komplex  b"));
    await expect(confirmPartnerLink(testPrisma, sa, acc.id)).rejects.toThrow(UnknownPartnerNameError);

    // Still pending, still granting nothing, and no audit row claiming an approval.
    const row = await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.partnerLinkConfirmedAt).toBeNull();
    expect(await testPrisma.partnerLinkAudit.count({ where: { action: "confirm" } })).toBe(0);
  });

  it("CONFIRM fails CLOSED when the live list cannot be fetched", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    const sa = await owner();

    vi.mocked(fetchPartners).mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(confirmPartnerLink(testPrisma, sa, acc.id)).rejects.toThrow(PartnerListUnavailableError);
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).partnerLinkConfirmedAt)
      .toBeNull();
  });

  it("REJECTING clears the link and frees the building for someone else to claim", async () => {
    const t = await makeTeamWithUsers();
    const first = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    const sa = await owner();

    await rejectPartnerLink(testPrisma, sa, first.id);
    const rejected = await testPrisma.account.findUniqueOrThrow({ where: { id: first.id } });
    expect(rejected.externalPartnerKey).toBeNull();
    expect(rejected.partnerLinkConfirmedAt).toBeNull();
    // The proposer goes with the key. A stale proposer would block that person from confirming
    // the NEXT proposal on this account — which would be somebody else's proposal.
    expect(rejected.partnerLinkProposedById).toBeNull();

    // Freed: another team can now stake it. A DIFFERENT company, because the per-company
    // buildingKey index still holds the name inside this one — the account still exists and is
    // still called "Komplex B".
    const other = await makeTeamWithUsers();
    const second = await createAccount(testPrisma, other.suMember, { name: "Komplex B" });
    expect(second.externalPartnerKey).toBe("komplex b");
  });

  it("a PENDING link blocks a second member from pending the same building", async () => {
    const t = await makeTeamWithUsers();
    await createAccount(testPrisma, t.suMember, { name: "Komplex B" });

    // Same company: the building claim guard refuses outright — one building, one team.
    await expect(
      createAccount(testPrisma, t.suAdmin, { name: "komplex  b", accountManagerId: t.admin.id }),
    ).rejects.toThrow(BuildingClaimedError);

    // Another company: the building claim is per company, so the create SUCCEEDS, but the global
    // partner namespace is not up for grabs — it stakes nothing.
    const other = await makeTeamWithUsers();
    const rival = await createAccount(testPrisma, other.suMember, { name: "Komplex B" });
    expect(rival.externalPartnerKey).toBeNull();
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "komplex b" } })).toBe(1);
  });

  // A MEMBER NEVER CONFIRMS — not even their own proposal. That separation IS the gate: the whole
  // finding was that a salesperson could name a building and read the complex, and letting them
  // approve their own proposal would restore exactly that in two clicks instead of one.
  it("a MEMBER may not confirm or reject, including their own pending link", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));

    await expect(confirmPartnerLink(testPrisma, t.suMember, acc.id)).rejects.toThrow(ForbiddenError);
    await expect(rejectPartnerLink(testPrisma, t.suMember, acc.id)).rejects.toThrow(ForbiddenError);

    // A PARTNER_VIEWER pinned to this very account is no exception either.
    const viewer = await makeUser("PARTNER_VIEWER", t.team, { accountId: acc.id });
    await expect(confirmPartnerLink(testPrisma, su(viewer), acc.id)).rejects.toThrow(ForbiddenError);

    const row = await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.externalPartnerKey).toBe("komplex b"); // untouched, still pending
    expect(row.partnerLinkConfirmedAt).toBeNull();
    // ...and the member still reads nothing.
    expect((await getAccountAnalytics(testPrisma, t.suMember, acc.id, range)).status)
      .toBe("not-configured");
  });

  // CROSS-TEAM IS A 404, NOT A 403. Another team's account must be indistinguishable from one that
  // does not exist, which is the shape every other cross-team miss in the codebase has.
  it("a team admin confirming ANOTHER team's pending link gets NotFound, not Forbidden", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.companyId });
    const acc = await createAccount(testPrisma, theirs.suMember, { name: "Komplex B" });
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));

    await expect(confirmPartnerLink(testPrisma, mine.suAdmin, acc.id)).rejects.toThrow(NotFoundError);
    await expect(rejectPartnerLink(testPrisma, mine.suAdmin, acc.id)).rejects.toThrow(NotFoundError);

    const row = await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.partnerLinkConfirmedAt).toBeNull();

    // Their OWN admin can, which is what makes the refusal above about scope and not about role.
    const confirmed = await confirmPartnerLink(testPrisma, theirs.suAdmin, acc.id);
    expect(confirmed.partnerLinkConfirmedAt).toBeInstanceOf(Date);
  });

  it("a SUPER_ADMIN may confirm any team's link", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));

    const confirmed = await confirmPartnerLink(testPrisma, await owner(), acc.id);
    expect(confirmed.externalPartnerKey).toBe("Komplex B");
    expect(confirmed.partnerLinkConfirmedAt).toBeInstanceOf(Date);
  });

  it("confirm and reject refuse an account with nothing awaiting a decision", async () => {
    const t = await makeTeamWithUsers();
    const sa = await owner();
    // No link at all.
    const bare = await testPrisma.account.create({ data: {
      companyId: t.companyId, teamId: t.team.id, name: "Bare", buildingKey: buildingKey("Bare"),
      accountManagerId: t.member.id,
    } });
    await expect(confirmPartnerLink(testPrisma, sa, bare.id)).rejects.toThrow(NoPendingPartnerLinkError);
    await expect(rejectPartnerLink(testPrisma, sa, bare.id)).rejects.toThrow(NoPendingPartnerLinkError);

    // Already CONFIRMED: reject is the wrong verb (clearing a live link is setAccountPartner(null)),
    // while confirm is idempotent and simply returns the account as it stands.
    const live = await testPrisma.account.create({ data: {
      companyId: t.companyId, teamId: t.team.id, name: "Live", buildingKey: buildingKey("Live"),
      accountManagerId: t.member.id, externalPartnerKey: "Komplex B", partnerLinkConfirmedAt: new Date(),
    } });
    await expect(rejectPartnerLink(testPrisma, sa, live.id)).rejects.toThrow(NoPendingPartnerLinkError);
    const again = await confirmPartnerLink(testPrisma, sa, live.id);
    expect(again.externalPartnerKey).toBe("Komplex B");
    expect(fetchPartners).not.toHaveBeenCalled(); // short-circuited before the upstream
    expect(await testPrisma.partnerLinkAudit.count({ where: { action: "confirm" } })).toBe(0);
  });

  // EXISTING CONFIRMED LINKS KEEP WORKING. This is what the migration's backfill guarantees for
  // the accounts already live in prod and dev; here it is asserted against the gate itself.
  it("an already-confirmed link keeps serving data, untouched by the gate", async () => {
    const t = await makeTeamWithUsers();
    const acc = await testPrisma.account.create({ data: {
      companyId: t.companyId, teamId: t.team.id, name: "Legacy", buildingKey: buildingKey("Legacy"),
      accountManagerId: t.member.id, externalPartnerKey: "Komplex B",
      partnerLinkConfirmedAt: new Date("2026-01-01T00:00:00Z"),
    } });

    const analytics = await getAccountAnalytics(testPrisma, t.suMember, acc.id, range);
    expect(analytics.status).toBe("ok");
    expect(analytics.kpis.totalDebt).toBe(999);

    mockUser = t.suMember;
    const res = await objectsGET(new NextRequest(`http://localhost/api/accounts/${acc.id}/objects`), {
      params: Promise.resolve({ id: acc.id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("audits every transition, with the right actor on each", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    const sa = await owner();
    await confirmPartnerLink(testPrisma, sa, acc.id);

    const rows = await testPrisma.partnerLinkAudit.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["pending", "confirm"]);
    // The salesperson PROPOSED it; the owner GRANTED it. Collapsing those two into one actor is
    // exactly what made the old trail unable to answer who allowed the data out.
    expect(rows[0].actorId).toBe(t.member.id);
    expect(rows[1].actorId).toBe(sa.id);
    expect(rows[0].partnerName).toBe("komplex b");
    expect(rows[1].partnerName).toBe("Komplex B");

    // Reject on a fresh pending link gets its own row, carrying the refused name.
    const other = await makeTeamWithUsers();
    const second = await createAccount(testPrisma, other.suMember, { name: "Sabah City" });
    await rejectPartnerLink(testPrisma, sa, second.id);
    const rejectRow = await testPrisma.partnerLinkAudit.findFirstOrThrow({ where: { action: "reject" } });
    expect(rejectRow).toMatchObject({ actorId: sa.id, partnerName: "sabah city", accountId: second.id });
  });

  it("the owner's queue lists each pending link with the member who staked it", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    const sa = await owner();

    const queue = await listPendingPartnerLinks(testPrisma, sa);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      accountId: acc.id, accountName: "Komplex B",
      teamName: t.team.name, partnerName: "komplex b",
      requestedBy: t.member.name,
    });

    // A confirmed link is not a pending one.
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    await confirmPartnerLink(testPrisma, sa, acc.id);
    expect(await listPendingPartnerLinks(testPrisma, sa)).toEqual([]);
  });

  // The queue is admin-and-up, and SCOPED: a team admin must not learn which buildings another
  // team is working, which is the same boundary the rest of the accounts surface enforces.
  it("the queue is admin-only and shows a team admin ONLY their own team", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.companyId });
    const ours = await createAccount(testPrisma, mine.suMember, { name: "Komplex B" });
    await createAccount(testPrisma, theirs.suMember, { name: "Sabah City" });

    const forMine = await listPendingPartnerLinks(testPrisma, mine.suAdmin);
    expect(forMine.map((r) => r.accountId)).toEqual([ours.id]);

    // The owner sees both teams.
    const forOwner = await listPendingPartnerLinks(testPrisma, await owner());
    expect(forOwner).toHaveLength(2);

    // A MEMBER is refused before any query runs — they must not even learn what is awaiting a
    // decision.
    await expect(listPendingPartnerLinks(testPrisma, mine.suMember)).rejects.toThrow(ForbiddenError);
  });

  // ─── THE TWO-PERSON RULE ────────────────────────────────────────────────────────────────────
  //
  // A COMPANY_ADMIN is also a salesperson. Without this rule an admin could name any building and
  // approve their own access to that complex's debt, payments and unit-level owner names/phones —
  // one person on both sides of the gate, which is the finding all over again with an extra click.

  it("an admin CANNOT confirm a link they proposed themselves, and the account stays dark", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    // The admin names the building, so the admin is the proposer.
    const acc = await createAccount(testPrisma, t.suAdmin, {
      name: "Komplex B", accountManagerId: t.admin.id,
    });
    expect(
      (await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).partnerLinkProposedById,
    ).toBe(t.admin.id);

    await expect(confirmPartnerLink(testPrisma, t.suAdmin, acc.id)).rejects.toThrow(SelfApprovalError);

    const row = await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.partnerLinkConfirmedAt).toBeNull();
    expect(row.externalPartnerKey).toBe("komplex b"); // the claim is kept, the grant refused
    // No data on the surface that matters, and no audit row claiming an approval.
    expect((await getAccountAnalytics(testPrisma, t.suAdmin, acc.id, range)).status)
      .toBe("not-configured");
    expect(await testPrisma.partnerLinkAudit.count({ where: { action: "confirm" } })).toBe(0);
  });

  // The refusal is checked BEFORE the upstream call, so a proposer cannot use their own confirm
  // attempt as a probe for whether the complex they guessed is real.
  it("the self-approval refusal reveals nothing about the complex, and costs no upstream call", async () => {
    const t = await makeTeamWithUsers();
    const real = await createAccount(testPrisma, t.suAdmin, {
      name: "Komplex B", accountManagerId: t.admin.id,
    });
    const other = await makeTeamWithUsers({ companyId: t.companyId });
    const fake = await createAccount(testPrisma, other.suAdmin, {
      name: "No Such Complex", accountManagerId: other.admin.id,
    });
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));

    await expect(confirmPartnerLink(testPrisma, t.suAdmin, real.id)).rejects.toThrow(SelfApprovalError);
    await expect(confirmPartnerLink(testPrisma, other.suAdmin, fake.id)).rejects.toThrow(SelfApprovalError);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("a SECOND admin on the same team CAN confirm the first admin's proposal", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suAdmin, {
      name: "Komplex B", accountManagerId: t.admin.id,
    });
    const colleague = await secondAdmin(t.team);

    const confirmed = await confirmPartnerLink(testPrisma, colleague, acc.id);
    expect(confirmed.externalPartnerKey).toBe("Komplex B");
    expect(confirmed.partnerLinkConfirmedAt).toBeInstanceOf(Date);
    // The proposer is KEPT on confirm: the record of who asked must survive the approval.
    expect(confirmed.partnerLinkProposedById).toBe(t.admin.id);
    // And the accountable party on the audit row is the colleague who approved it.
    const audit = await testPrisma.partnerLinkAudit.findFirstOrThrow({ where: { action: "confirm" } });
    expect(audit.actorId).toBe(colleague.id);
  });

  // THE OWNER IS EXEMPT, on purpose. Without the exemption a link the super admin proposed would
  // be unapprovable by anybody — they are the last resort, not a second pair of eyes.
  it("a SUPER_ADMIN CAN confirm a link they proposed themselves", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const sa = await owner();
    // A super admin creating an account names its manager; the proposer is the super admin.
    const acc = await createAccount(testPrisma, sa, {
      name: "Komplex B", accountManagerId: t.member.id,
    });
    expect(
      (await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).partnerLinkProposedById,
    ).toBe(sa.id);

    const confirmed = await confirmPartnerLink(testPrisma, sa, acc.id);
    expect(confirmed.partnerLinkConfirmedAt).toBeInstanceOf(Date);
  });

  // Rejecting your own proposal is ALLOWED, and the asymmetry is deliberate: the rule exists to
  // stop someone GRANTING themselves a complex, and refusing never grants anything. Blocking it
  // would only trap a mistyped building name in the queue with nobody able to clear it.
  it("an admin MAY reject their own proposal, which frees the building", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suAdmin, {
      name: "Komplex B", accountManagerId: t.admin.id,
    });

    const rejected = await rejectPartnerLink(testPrisma, t.suAdmin, acc.id);
    expect(rejected.externalPartnerKey).toBeNull();
    expect(rejected.partnerLinkProposedById).toBeNull();

    const other = await makeTeamWithUsers();
    const second = await createAccount(testPrisma, other.suMember, { name: "Komplex B" });
    expect(second.externalPartnerKey).toBe("komplex b");
  });

  // The queue tells the proposer why they cannot act, rather than hiding the row — a proposal that
  // vanished from their own list would read as lost.
  it("the queue flags a link the viewer proposed, and does not flag it for the owner", async () => {
    const t = await makeTeamWithUsers();
    await createAccount(testPrisma, t.suAdmin, { name: "Komplex B", accountManagerId: t.admin.id });

    const mine = await listPendingPartnerLinks(testPrisma, t.suAdmin);
    expect(mine).toHaveLength(1);
    expect(mine[0].proposedByMe).toBe(true);
    expect(mine[0].requestedBy).toBe(t.admin.name);

    const colleague = await secondAdmin(t.team);
    expect((await listPendingPartnerLinks(testPrisma, colleague))[0].proposedByMe).toBe(false);
    expect((await listPendingPartnerLinks(testPrisma, await owner()))[0].proposedByMe).toBe(false);
  });

  // RENAMING RE-STAKES A PENDING PROPOSAL, because the pending key is derived from the name: a
  // typo would otherwise leave a proposal that can never be confirmed and nothing able to fix it.
  // A CONFIRMED link is never re-pointed by a rename — that is live data.
  it("renaming re-stakes a PENDING link and makes the renamer the proposer; a CONFIRMED link is untouched", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex Bee" });
    expect(acc.externalPartnerKey).toBe("komplex bee");

    // The admin corrects the name: the proposal follows, and the admin now owns it.
    const renamed = await updateAccount(testPrisma, t.suAdmin, acc.id, { name: "Komplex B" });
    expect(renamed.externalPartnerKey).toBe("komplex b");
    expect(renamed.partnerLinkConfirmedAt).toBeNull();
    expect(renamed.partnerLinkProposedById).toBe(t.admin.id);
    // ...so the admin cannot confirm it, and their colleague can.
    await expect(confirmPartnerLink(testPrisma, t.suAdmin, acc.id)).rejects.toThrow(SelfApprovalError);
    const confirmed = await confirmPartnerLink(testPrisma, await secondAdmin(t.team), acc.id);
    expect(confirmed.externalPartnerKey).toBe("Komplex B");

    // Now it is LIVE. A further rename changes the name and the buildingKey and leaves the link
    // exactly as approved — renaming an account must never re-point live partner data.
    const again = await updateAccount(testPrisma, t.suAdmin, acc.id, { name: "Renamed Again" });
    expect(again.externalPartnerKey).toBe("Komplex B");
    expect(again.partnerLinkConfirmedAt).toEqual(confirmed.partnerLinkConfirmedAt);
    expect(again.buildingKey).toBe("renamed again");
  });

  // A rename whose new name normalizes to the key the account ALREADY holds must keep the
  // proposal. The taken-key pre-check has to except the account itself, or the account finds
  // itself in the taken set and silently drops its own pending link.
  it("a rename that normalizes onto the account's OWN pending key keeps the proposal", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    expect(acc.externalPartnerKey).toBe("komplex b");

    const renamed = await updateAccount(testPrisma, t.suAdmin, acc.id, { name: "KOMPLEX  b" });
    expect(renamed.externalPartnerKey).toBe("komplex b");
    expect(renamed.partnerLinkConfirmedAt).toBeNull();
    // Same key, so nothing transitioned and no second audit row was written.
    expect(await testPrisma.partnerLinkAudit.count({ where: { action: "pending" } })).toBe(1);
  });

  // The owner's DIRECT assign is itself an approval: it is behind assertRole(SUPER_ADMIN) and the
  // name was just verified against the live list. Leaving it pending would have the owner approve
  // their own explicit assignment — and, worse, write a link that silently reads as unconfigured.
  it("the SUPER_ADMIN's direct assign confirms immediately; clearing resets the stamp", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await testPrisma.account.create({ data: {
      companyId: t.companyId, teamId: t.team.id, name: "Unstaked", buildingKey: buildingKey("Unstaked"),
      accountManagerId: t.member.id,
    } });
    const sa = await owner();

    const assigned = await setAccountPartner(testPrisma, sa, acc.id, "Komplex B");
    expect(assigned.partnerLinkConfirmedAt).toBeInstanceOf(Date);
    expect((await getAccountAnalytics(testPrisma, t.suMember, acc.id, range)).status).toBe("ok");

    const cleared = await setAccountPartner(testPrisma, sa, acc.id, null);
    expect(cleared.externalPartnerKey).toBeNull();
    // The stamp must go with the key: a stale stamp would make the NEXT pending link on this
    // account read as already approved.
    expect(cleared.partnerLinkConfirmedAt).toBeNull();
  });
});

void makeTeam;
