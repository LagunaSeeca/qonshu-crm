import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeamWithUsers, makeUser, su, uniq, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import { makePartnerStats } from "@/test/partner-stats-fixture";
import type { PartnerObjectsResponse } from "@/lib/partner-api/schema";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------------------------
// THE ONBOARDING ROLE, END TO END, AT THE SERVICE LAYER.
//
// WHY THE SERVICE AND NOT THE ROUTES. Server components call these functions directly and hand the
// result to client components as props, so a gate that lives only in `/api/...` still ships the
// data into the browser on the page render. Every assertion here therefore calls the service.
//
// WHAT IS BEING PROVEN, in three groups:
//   1. ONBOARDING sees the BUILDING and the RESIDENTS (units, owner names, phone numbers) for the
//      accounts it is ASSIGNED to — that is the activation checklist's raw material.
//   2. ONBOARDING sees NO MONEY anywhere: no service fees, no analytics, no payments, no
//      attachments (the Files tab holds signed contracts, which state prices), and the per-unit
//      debt/balance/net keys are REMOVED — omitted, not zeroed, because a fabricated 0 is a false
//      statement about money.
//   3. A MEMBER'S BEHAVIOUR IS UNCHANGED by any of it. That is asserted alongside every denial
//      rather than in one place, because "we hid money from onboarding" and "we hid money from the
//      sales team" are one careless `false` apart in the capability matrix.
// ---------------------------------------------------------------------------------------------

vi.mock("@/db/client", () => ({ prisma: testPrisma }));
vi.mock("@/lib/partner-api/client", () => ({
  fetchPartnerStats: vi.fn(),
  fetchPartnerObjects: vi.fn(),
  fetchPartners: vi.fn(),
}));

import { fetchPartnerStats, fetchPartnerObjects, fetchPartners } from "@/lib/partner-api/client";
import { createAccount, getAccount } from "./accounts";
import { getAccountObjects } from "./account-objects";
import { getAccountServiceFees, listCompanyServiceFees, addServiceFee, markFeePaid } from "./service-fees";
import { getAccountAnalytics, listAccountPayments } from "./partner-analytics";
import { getCompanyAnalytics } from "./company-analytics";
import {
  listAccountAttachments, getAccountAttachmentForDownload, addAccountAttachment,
} from "./account-attachments";
import { addAccountTask, toggleAccountTask, listAccountTasks } from "./account-tasks";
import { addAsk, resolveAsk } from "./account-asks";
import { addAccountActivity, listAccountActivities } from "./account-activities";
import { getAccountFields, setAccountFieldValue, defScopeWhere, resolveFieldDefScope, listFieldDefs, createFieldDef } from "./account-fields";
import { getAccountInstallSnapshots, upsertInstallSnapshot } from "./platform-installs";
import { listCompanySettlements, getAccountSettlement } from "./settlements";
import { getDashboardStats } from "./dashboard";
import { getReport } from "./reports";
import { getMyWork } from "./work";
import { listLeads } from "./leads";
import { resolveStageScope } from "./stages";
import { createUser, listAssignableUsers, InvalidUserRoleError } from "./users";
import { listPendingPartnerLinks, confirmPartnerLink } from "./partner-link-approval";
import { maskAccount } from "./account-dto";

const RANGE = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-31T23:59:59Z") };

function rawObjects(): PartnerObjectsResponse {
  return {
    partner: "acme",
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
              { id: 100, owner_id: 5, owner_name: "Jane Resident", owner_mobile: "+994501112233", debt: 250, balance: 10, net: -999, apartment_number: "12B" },
            ],
          },
        ],
        parkings: [
          { id: 200, owner_id: 7, owner_name: "Bob Resident", owner_mobile: "+994502223344", debt: 40, balance: 0, net: -40, parking_number: "P-7" },
        ],
        properties: [
          { id: 300, owner_id: 9, owner_name: "Acme LLC", owner_mobile: null, debt: 5, balance: 0, net: -5, property_number: "R-1", type: "SHOP" },
        ],
        offices: [
          { id: 400, owner_id: 9, owner_name: "Acme LLC", owner_mobile: "+994503334455", debt: 0, balance: 100, net: 100, office_number: "O-2" },
        ],
      },
    ],
  };
}

let savedApiKey: string | undefined;

async function prepare() {
  await resetDb();
  savedApiKey = process.env.PARTNER_API_KEY;
  process.env.PARTNER_API_KEY = "sk_test_shared";
  vi.mocked(fetchPartners).mockReset();
  vi.mocked(fetchPartners).mockResolvedValue({ partners: [] });
  vi.mocked(fetchPartnerStats).mockReset();
  vi.mocked(fetchPartnerStats).mockResolvedValue(makePartnerStats({ total_debt: 9999, amount_by_card: 500 }));
  vi.mocked(fetchPartnerObjects).mockReset();
  vi.mocked(fetchPartnerObjects).mockResolvedValue(rawObjects());
}

function restore() {
  if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
  else process.env.PARTNER_API_KEY = savedApiKey;
}

// One company, one team. `mine` is managed by the member and ASSIGNED to both the member's
// teammate and the onboarding user — several people on one building, which is the model. `other` is
// the teammate's building that nobody else is assigned to.
async function world() {
  const t = await makeTeamWithUsers();
  const onboarder = await makeUser("ONBOARDING", t.team);
  const mine = await testPrisma.account.create({
    data: {
      companyId: t.companyId, teamId: t.team.id, name: "Mine Tower",
      buildingKey: buildingKey(uniq("mine-")), accountManagerId: t.member.id,
      ...confirmedPartnerLink("acme"),
    },
  });
  const other = await createAccount(testPrisma, t.suAdmin, { name: uniq("Other Tower ") });
  await testPrisma.accountAssignment.create({
    data: { companyId: t.companyId, accountId: mine.id, userId: onboarder.id },
  });
  return { ...t, onboarder, suOnboarder: su(onboarder), mine, other };
}

const caught = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null; } catch (e) { return e; }
};

describe("ONBOARDING: the building and the residents, never the money", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  // ---- group 1: what onboarding DOES get -----------------------------------------------------

  it("gets the full unit tree with owner names and phones for an assigned account", async () => {
    const w = await world();
    const res = await getAccountObjects(w.suOnboarder, w.mine.id);
    expect(res).toMatchObject({ status: "ok", detail: "full" });
    const text = JSON.stringify(res);
    // The activation checklist is "text the residents, add them to WhatsApp, train the manager".
    expect(text).toContain("Jane Resident");
    expect(text).toContain("+994501112233");
    expect(text).toContain("12B");
    // Counts are untouched: ObjectsTotals carries no monetary field, so nothing is stripped there.
    expect((res as { totals: unknown }).totals).toEqual({
      buildings: 1, blocks: 1, apartments: 1, parkings: 1, properties: 1, offices: 1,
    });
  });

  it("the per-unit money keys are ABSENT, not zeroed, in every unit collection", async () => {
    const w = await world();
    const res = await getAccountObjects(w.suOnboarder, w.mine.id) as {
      buildings: {
        blocks: { apartments: Record<string, unknown>[] }[];
        parkings: Record<string, unknown>[];
        properties: Record<string, unknown>[];
        offices: Record<string, unknown>[];
      }[];
    };
    const b = res.buildings[0];
    const units = [...b.blocks.flatMap((bl) => bl.apartments), ...b.parkings, ...b.properties, ...b.offices];
    expect(units).toHaveLength(4); // every collection covered, none silently skipped
    for (const u of units) {
      // `in`, not `=== undefined`: a fabricated 0 would be a false statement about money, and a
      // present-but-undefined key would read as "we know it is nothing". The key must be gone.
      expect("debt" in u).toBe(false);
      expect("balance" in u).toBe(false);
      expect("net" in u).toBe(false);
      // and the non-money fields survive
      expect(u).toHaveProperty("number");
      expect(u).toHaveProperty("ownerName");
    }
    // Belt and braces on the serialized payload the client bundle would receive.
    const text = JSON.stringify(res);
    expect(text).not.toContain("debt");
    expect(text).not.toContain("balance");
    expect(text).not.toContain("250"); // Jane's debt
  });

  it("an ADMIN still gets the money on the same payload (the strip is per-role, not global)", async () => {
    const w = await world();
    const res = await getAccountObjects(w.suAdmin, w.mine.id) as {
      buildings: { blocks: { apartments: { debt: number; net: number }[] }[] }[];
    };
    const apt = res.buildings[0].blocks[0].apartments[0];
    expect(apt.debt).toBe(250);
    expect(apt.net).toBe(10 - 250); // recomputed, never the upstream's -999
  });

  it("still reads the non-money sub-resources of an assigned account", async () => {
    const w = await world();
    // Seeded by someone who may write, then read back as the onboarding user.
    await addAccountTask(testPrisma, w.suMember, w.mine.id, { title: "Install the app" });
    await addAccountActivity(testPrisma, w.suMember, w.mine.id, { kind: "NOTE", body: "Kickoff" });
    expect(await listAccountTasks(testPrisma, w.suOnboarder, w.mine.id)).toHaveLength(1);
    expect(await listAccountActivities(testPrisma, w.suOnboarder, w.mine.id)).toHaveLength(1);
    // Install snapshots are counts, not money, and activation tracking needs them.
    await upsertInstallSnapshot(testPrisma, w.suMember, w.mine.id, {
      capturedOn: new Date("2026-01-10T00:00:00Z"), iosInstalls: 3, androidInstalls: 4,
    });
    expect(await getAccountInstallSnapshots(testPrisma, w.suOnboarder, w.mine.id)).toHaveLength(1);
    // The account's custom field VALUES read against the ACCOUNT's team, not the reader's — which
    // is what lets a team-less onboarding user see them read-only at all.
    const def = await createFieldDef(testPrisma, w.suAdmin, { label: "Floors", type: "NUMBER" });
    await setAccountFieldValue(testPrisma, w.suMember, w.mine.id, def.id, "12");
    const rows = await getAccountFields(testPrisma, w.suOnboarder, w.mine.id);
    expect(rows.map((r) => [r.label, r.value])).toEqual([["Floors", "12"]]);
  });

  // ---- group 2: no money, anywhere -----------------------------------------------------------

  it("is refused every financial read, while a MEMBER is refused none of them", async () => {
    const w = await world();
    const financialReads: [string, (u: typeof w.suOnboarder) => Promise<unknown>][] = [
      ["getAccountServiceFees", (u) => getAccountServiceFees(testPrisma, u, w.mine.id)],
      ["listCompanyServiceFees", (u) => listCompanyServiceFees(testPrisma, u)],
      ["getAccountAnalytics", (u) => getAccountAnalytics(testPrisma, u, w.mine.id, RANGE)],
      ["listAccountPayments", (u) => listAccountPayments(testPrisma, u, w.mine.id, RANGE)],
      ["getCompanyAnalytics", (u) => getCompanyAnalytics(testPrisma, u, RANGE)],
      ["listAccountAttachments", (u) => listAccountAttachments(testPrisma, u, w.mine.id)],
      ["getAccountAttachmentForDownload", (u) => getAccountAttachmentForDownload(testPrisma, u, "any-id")],
    ];
    for (const [name, call] of financialReads) {
      expect(await caught(() => call(w.suOnboarder)), `${name} must refuse ONBOARDING`)
        .toBeInstanceOf(ForbiddenError);
    }
    // NOT ONE UPSTREAM CALL was made on behalf of the onboarding user: the gate is before the
    // network, so a denied caller cannot even be used to probe the Partner API.
    expect(fetchPartnerStats).not.toHaveBeenCalled();

    // THE OTHER HALF: a MEMBER must still get all of these. `listAccountPayments` is the one
    // exception, and it is pre-existing — a member has never held `view_payment_detail`.
    expect(await caught(() => getAccountServiceFees(testPrisma, w.suMember, w.mine.id))).toBeNull();
    expect(await caught(() => listCompanyServiceFees(testPrisma, w.suMember))).toBeNull();
    expect(await caught(() => getAccountAnalytics(testPrisma, w.suMember, w.mine.id, RANGE))).toBeNull();
    expect(await caught(() => getCompanyAnalytics(testPrisma, w.suMember, RANGE))).toBeNull();
    expect(await caught(() => listAccountAttachments(testPrisma, w.suMember, w.mine.id))).toBeNull();
    expect(await caught(() => listAccountPayments(testPrisma, w.suMember, w.mine.id, RANGE)))
      .toBeInstanceOf(ForbiddenError);
  });

  it("a MEMBER's financial figures are the real ones, not an emptied shell", async () => {
    const w = await world();
    // Proving the gate did not quietly turn a member's reads into zeros.
    await addServiceFee(testPrisma, w.suMember, w.mine.id, {
      periodMonth: new Date("2026-01-01T00:00:00Z"), amount: 300,
    });
    const fees = await getAccountServiceFees(testPrisma, w.suMember, w.mine.id);
    expect(fees.totalBilled).toBe(300);
    expect((await listCompanyServiceFees(testPrisma, w.suMember)).totals.billed).toBe(300);
    const analytics = await getAccountAnalytics(testPrisma, w.suMember, w.mine.id, RANGE);
    expect(analytics.status).toBe("ok");
    expect(analytics.kpis.totalDebt).toBe(9999);
  });

  it("is refused settlements, the CRM, the dashboard, reports and /work", async () => {
    const w = await world();
    const refusals: [string, () => Promise<unknown>][] = [
      // Settlements: already excluded by view_settlements, re-asserted because this is the single
      // most sensitive money surface in the app.
      ["listCompanySettlements", () => listCompanySettlements(testPrisma, w.suOnboarder)],
      ["getAccountSettlement", () => getAccountSettlement(testPrisma, w.suOnboarder, w.mine.id)],
      // The CRM side. All of these resolve their scope through leadScopeWhere, so the single
      // ONBOARDING throw there is what closes every one of them.
      ["listLeads", () => listLeads(testPrisma, w.suOnboarder)],
      ["getMyWork", () => getMyWork(testPrisma, w.suOnboarder)],
      ["getDashboardStats", () => getDashboardStats(testPrisma, w.suOnboarder, RANGE)],
      ["getReport", () => getReport(testPrisma, w.suOnboarder, { range: RANGE, label: "Jan 2026" })],
      ["resolveStageScope", () => resolveStageScope(testPrisma, w.suOnboarder, {})],
      // Field DEFINITIONS are a team's columns and onboarding has no team. (The per-account field
      // VALUES still read, asserted above — that distinction is the point.)
      ["defScopeWhere", async () => defScopeWhere(w.suOnboarder)],
      ["resolveFieldDefScope", () => resolveFieldDefScope(testPrisma, w.suOnboarder, {})],
      ["listFieldDefs", async () => listFieldDefs(testPrisma, w.suOnboarder)],
      // Partner-link approval: granting an account the right to read a complex's live data.
      ["listPendingPartnerLinks", () => listPendingPartnerLinks(testPrisma, w.suOnboarder)],
      ["confirmPartnerLink", () => confirmPartnerLink(testPrisma, w.suOnboarder, w.mine.id)],
      // Owner pickers: onboarding can neither be offered one nor appear in one (see scope.test.ts).
      ["listAssignableUsers", () => listAssignableUsers(testPrisma, w.suOnboarder)],
    ];
    for (const [name, call] of refusals) {
      expect(await caught(call), `${name} must refuse ONBOARDING`).toBeInstanceOf(ForbiddenError);
    }
  });

  it("the account API key stays masked for ONBOARDING, as for every role but the owner", async () => {
    const w = await world();
    const row = await testPrisma.account.findUniqueOrThrow({ where: { id: w.mine.id } });
    const masked = maskAccount(row, w.suOnboarder);
    expect(masked.externalApiKeyEnc).toBeUndefined();
    expect(masked.externalApiKeyLast4).toBeUndefined();
    // The partner NAME and its confirmation stamp go too: only a SUPER_ADMIN keeps them.
    expect(masked.externalPartnerKey).toBeUndefined();
    expect(masked.partnerLinkConfirmedAt).toBeUndefined();
  });

  // ---- group 3: one gate for account writes --------------------------------------------------

  it("is refused every sub-resource write on an account it IS assigned to", async () => {
    const w = await world();
    const writes: [string, () => Promise<unknown>][] = [
      ["addAccountTask", () => addAccountTask(testPrisma, w.suOnboarder, w.mine.id, { title: "x" })],
      ["addAsk", () => addAsk(testPrisma, w.suOnboarder, w.mine.id, { title: "x" })],
      ["addAccountActivity", () => addAccountActivity(testPrisma, w.suOnboarder, w.mine.id, { kind: "NOTE", body: "x" })],
      ["addAccountAttachment", () => addAccountAttachment(testPrisma, w.suOnboarder, w.mine.id, { filename: "a.txt", mime: "text/plain", bytes: Buffer.from("x") })],
      ["setAccountFieldValue", async () => {
        const def = await createFieldDef(testPrisma, w.suAdmin, { label: uniq("F "), type: "TEXT" });
        return setAccountFieldValue(testPrisma, w.suOnboarder, w.mine.id, def.id, "v");
      }],
      ["upsertInstallSnapshot", () => upsertInstallSnapshot(testPrisma, w.suOnboarder, w.mine.id, { capturedOn: new Date("2026-02-01T00:00:00Z"), iosInstalls: 1, androidInstalls: 1 })],
      ["addServiceFee", () => addServiceFee(testPrisma, w.suOnboarder, w.mine.id, { periodMonth: new Date("2026-01-01T00:00:00Z"), amount: 1 })],
    ];
    for (const [name, call] of writes) {
      expect(await caught(call), `${name} must refuse ONBOARDING`).toBeInstanceOf(ForbiddenError);
    }
    // Refused AND nothing written — the double assertion this codebase makes for every denial.
    expect(await testPrisma.accountTask.count({ where: { accountId: w.mine.id } })).toBe(0);
    expect(await testPrisma.accountAsk.count({ where: { accountId: w.mine.id } })).toBe(0);
    expect(await testPrisma.accountActivity.count({ where: { accountId: w.mine.id } })).toBe(0);
    expect(await testPrisma.accountAttachment.count({ where: { accountId: w.mine.id } })).toBe(0);
    expect(await testPrisma.serviceFee.count({ where: { accountId: w.mine.id } })).toBe(0);
    expect(await testPrisma.accountFieldValue.count({ where: { accountId: w.mine.id } })).toBe(0);
    expect(await testPrisma.platformInstallSnapshot.count({ where: { accountId: w.mine.id } })).toBe(0);
  });

  it("the by-id child mutations refuse identically for a real id and an invented one", async () => {
    const w = await world();
    const task = await addAccountTask(testPrisma, w.suMember, w.mine.id, { title: "real" });
    const ask = await addAsk(testPrisma, w.suMember, w.mine.id, { title: "real" });
    const fee = await addServiceFee(testPrisma, w.suMember, w.mine.id, {
      periodMonth: new Date("2026-01-01T00:00:00Z"), amount: 10,
    });
    // The capability is hoisted ABOVE the child lookup precisely so these pairs match: otherwise
    // "403 for a real id, 404 for a fake one" is an id-probing oracle over every account task,
    // ask and invoice in the org, for exactly the role being kept out.
    const pairs: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ["toggleAccountTask",
        () => toggleAccountTask(testPrisma, w.suOnboarder, task.id, true),
        () => toggleAccountTask(testPrisma, w.suOnboarder, "no-such-task", true)],
      ["resolveAsk",
        () => resolveAsk(testPrisma, w.suOnboarder, ask.id),
        () => resolveAsk(testPrisma, w.suOnboarder, "no-such-ask")],
      ["markFeePaid",
        () => markFeePaid(testPrisma, w.suOnboarder, fee.id, {}),
        () => markFeePaid(testPrisma, w.suOnboarder, "no-such-fee", {})],
    ];
    for (const [name, real, fake] of pairs) {
      const r = await caught(real);
      const f = await caught(fake);
      expect(r, name).toBeInstanceOf(ForbiddenError);
      expect(f, name).toBeInstanceOf(ForbiddenError);
      expect((r as Error).message, name).toBe((f as Error).message);
    }
    expect((await testPrisma.accountTask.findUniqueOrThrow({ where: { id: task.id } })).done).toBe(false);
    expect((await testPrisma.accountAsk.findUniqueOrThrow({ where: { id: ask.id } })).status).toBe("OPEN");
    expect((await testPrisma.serviceFee.findUniqueOrThrow({ where: { id: fee.id } })).status).toBe("UNPAID");
  });

  it("an UNASSIGNED account stays NotFound for ONBOARDING's reads", async () => {
    const w = await world();
    // Not a 403 that would confirm the id: the account is simply outside scope, so the chokepoint
    // answers null and the services answer NotFound, exactly as for any other out-of-scope id.
    expect(await getAccount(testPrisma, w.suOnboarder, w.other.id)).toBeNull();
    expect(await caught(() => getAccountObjects(w.suOnboarder, w.other.id)))
      .toBeNull(); // getAccountObjects returns a typed status rather than throwing
    expect(await getAccountObjects(w.suOnboarder, w.other.id)).toEqual({ status: "not_found" });
    expect(await caught(() => getAccountFields(testPrisma, w.suOnboarder, w.other.id)))
      .toBeInstanceOf(NotFoundError);
    expect(await listAccountTasks(testPrisma, w.suOnboarder, w.other.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// WHO MAY BE GIVEN WORK, and who may be CREATED.
// ---------------------------------------------------------------------------------------------
describe("ONBOARDING: assignability and user creation", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  it("a task may be assigned to the manager, to anyone ASSIGNED to the account, and to the team's admins", async () => {
    const t = await makeTeamWithUsers();
    const mate = await makeUser("MEMBER", t.team);
    const onboarder = await makeUser("ONBOARDING", t.team);
    const stranger = await makeUser("MEMBER", t.team);
    const acc = await createAccount(testPrisma, t.suMember, { name: uniq("Work ") });
    for (const u of [mate, onboarder]) {
      await testPrisma.accountAssignment.create({
        data: { companyId: t.companyId, accountId: acc.id, userId: u.id },
      });
    }

    // The manager and the team's admin: allowed before this change and still allowed.
    await expect(addAccountTask(testPrisma, t.suMember, acc.id, { title: "a", assigneeId: t.member.id })).resolves.toBeTruthy();
    await expect(addAccountTask(testPrisma, t.suMember, acc.id, { title: "b", assigneeId: t.admin.id })).resolves.toBeTruthy();
    // NEW: the assigned teammate and the assigned onboarding user. Assignment drives both
    // visibility and who can be handed work, read off the same AccountAssignment row.
    await expect(addAccountTask(testPrisma, t.suMember, acc.id, { title: "c", assigneeId: mate.id })).resolves.toBeTruthy();
    await expect(addAccountTask(testPrisma, t.suMember, acc.id, { title: "d", assigneeId: onboarder.id })).resolves.toBeTruthy();
    // A teammate with NO assignment is still refused: they could not open the account, so the task
    // would be a dead link in their list.
    await expect(addAccountTask(testPrisma, t.suMember, acc.id, { title: "e", assigneeId: stranger.id }))
      .rejects.toThrow(ForbiddenError);
    // An assignment on ANOTHER building grants nothing here (the lookup is by (account, user)).
    const elsewhere = await createAccount(testPrisma, t.suMember, { name: uniq("Elsewhere ") });
    await testPrisma.accountAssignment.create({
      data: { companyId: t.companyId, accountId: elsewhere.id, userId: stranger.id },
    });
    await expect(addAccountTask(testPrisma, t.suMember, acc.id, { title: "f", assigneeId: stranger.id }))
      .rejects.toThrow(ForbiddenError);
  });

  it("only a SUPER_ADMIN may create an ONBOARDING user, and it lands with teamId null", async () => {
    const t = await makeTeamWithUsers();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const args = { name: "Ops", password: "password123", role: "ONBOARDING" as const };

    // A team admin is refused outright. ForbiddenError, not a quietly-downgraded role.
    expect(await caught(() => createUser(testPrisma, t.suAdmin, {
      ...args, email: uniq("ob-") + "@test.local",
    }))).toBeInstanceOf(ForbiddenError);
    expect(await testPrisma.user.count({ where: { role: "ONBOARDING" } })).toBe(0);

    // The owner has companyId null (it sits above the org), so it must NAME the company — never
    // defaulted, for the same reason a super admin must name a team for an ordinary user.
    expect(await caught(() => createUser(testPrisma, sa, {
      ...args, email: uniq("ob-") + "@test.local",
    }))).toBeInstanceOf(InvalidUserRoleError);

    const created = await createUser(testPrisma, sa, {
      ...args, email: uniq("ob-") + "@test.local", companyId: t.companyId,
    });
    expect(created.role).toBe("ONBOARDING");
    expect(created.teamId).toBeNull();
    expect(created.companyId).toBe(t.companyId);
    expect(created.accountId).toBeNull();

    // A named team or account is REJECTED rather than dropped, so the mistake is visible.
    expect(await caught(() => createUser(testPrisma, sa, {
      ...args, email: uniq("ob-") + "@test.local", companyId: t.companyId, teamId: t.team.id,
    }))).toBeInstanceOf(InvalidUserRoleError);
  });

  it("an ONBOARDING user is never offered as an owner, and a session with a null team still resolves", async () => {
    const t = await makeTeamWithUsers();
    const onboarder = await makeUser("ONBOARDING", t.team);
    // Not in the admin's picker (users.ts TEAM_ROLES) — and scope.test.ts proves it is also
    // refused if named anyway (scope.ts OWNABLE_ROLES), which is the half that matters.
    const options = await listAssignableUsers(testPrisma, t.suAdmin);
    expect(options.map((u) => u.id)).not.toContain(onboarder.id);
    expect(options.every((u) => u.role === "COMPANY_ADMIN" || u.role === "MEMBER")).toBe(true);
    // The session shape itself: a non-SUPER_ADMIN with teamId null must be a valid session, not a
    // data bug something rejects. getSessionUser builds exactly this from the row.
    expect(su(onboarder)).toEqual({
      id: onboarder.id, companyId: t.companyId, teamId: null, role: "ONBOARDING", accountId: null,
    });
  });
});
