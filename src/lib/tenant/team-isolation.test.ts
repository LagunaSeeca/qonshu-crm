import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Account, Lead, Stage, StageType, User } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { makeCompany, makeTeam, makeUser, su, uniq, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import { makePartnerStats, makePartnerPayment } from "@/test/partner-stats-fixture";
import { ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/http";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { BuildingClaimedError } from "./building-claim";
import { createLead, getLead, listLeads, listLeadCards, updateLead, deleteLead, moveLeadStage } from "./leads";
import { convertLeadToAccount } from "./lead-conversion";
import {
  createAccount, getAccount, listAccounts, updateAccount, deleteAccount,
  createPartnerLogin, listPartnerLogins, PartnerLoginExistsError,
} from "./accounts";
import { addTask, toggleTask } from "./tasks";
import { toggleAccountTask } from "./account-tasks";
import { resolveAsk, reopenAsk } from "./account-asks";
import { deleteSettlementEntry, listCompanySettlements, getAccountSettlement } from "./settlements";
import {
  markFeePaid, markFeeUnpaid, updateServiceFee, deleteServiceFee, listCompanyServiceFees,
} from "./service-fees";
import { getMyWork } from "./work";
import { getDashboardStats } from "./dashboard";
import { getReport, toCsv } from "./reports";
import { listUsers, listAssignableUsers, getUser, setUserStatus, createUser, InvalidUserRoleError } from "./users";
import {
  resolveStageScope, listStages, updateStage, createStage, deleteStage, reorderStages, seedTeamStages,
} from "./stages";
import {
  listFieldDefs, createFieldDef, updateFieldDef, deleteFieldDef, reorderFieldDefs,
  resolveFieldDefScope, setAccountFieldValue, getAccountFields,
} from "./account-fields";
import { createTeamWithAdmin } from "./teams";
import { TEMPLATE_FIELD_DEFS } from "./team-template";
import { DEFAULT_STAGES } from "./stages";

// ---------------------------------------------------------------------------------------------
// CROSS-ROLE ISOLATION PROOF for the teams refactor.
//
// The unit suites prove each module in isolation. This file proves the MATRIX: one company, two
// sales teams, every role, every id-addressed entry point — and that nothing crosses a boundary
// it should not. Every denial is asserted TWICE: the call is refused (NotFound/Forbidden/409) AND
// the database row is checked afterwards, because a call that throws after writing is a leak too.
//
// THE MODEL UNDER TEST
//   MEMBER          only the leads they own and accounts they manage — not even a teammate's
//   COMPANY_ADMIN   their whole team ("Team Admin")
//   SUPER_ADMIN     everything. In production the owner carries a companyId (promoted inside the
//                   company by prisma/scripts/super-admin.ts) and teamId null; that is the shape
//                   modelled here as `sa`. `saNoCtx` is the same user without a company, which
//                   must fail closed on CRM reads (scope.ts) rather than widen.
//   PARTNER_VIEWER  one Account, no team, no CRM
// ---------------------------------------------------------------------------------------------

vi.mock("@/db/client", () => ({ prisma: testPrisma }));
let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => mockUser }));
// Partner API: hermetic. fetchPartners backs auto-link (always "no such complex"), fetchPartnerStats
// backs the analytics fan-out used by the dashboard and report.
vi.mock("@/lib/partner-api/client", () => ({
  fetchPartnerStats: vi.fn(),
  fetchPartners: vi.fn(async () => ({ partners: [] })),
}));

import { POST as POST_PARTNER_LOGIN } from "@/app/api/accounts/[id]/partner-login/route";

const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ----- helpers ---------------------------------------------------------------------------------

type Outcome = "ok" | "NotFound" | "Forbidden" | "Claimed" | "LoginExists" | string;

async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    if (e instanceof NotFoundError) return "NotFound";
    if (e instanceof ForbiddenError) return "Forbidden";
    if (e instanceof BuildingClaimedError) return "Claimed";
    if (e instanceof PartnerLoginExistsError) return "LoginExists";
    return `other:${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`;
  }
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw, but it resolved");
}

const sortIds = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const sorted = (xs: string[]) => [...xs].sort();
const nowRange = () => ({ from: new Date(Date.now() - 864e5), to: new Date(Date.now() + 864e5) });
const stageOf = (stages: Stage[], name: string) => stages.find((s) => s.name === name)!;
const firstOfType = (stages: Stage[], type: StageType) =>
  stages.filter((s) => s.type === type).sort((a, b) => a.order - b.order)[0];

type OwnerKey = "m1" | "m2" | "m3" | "adminA";
type ActorKey = "m1" | "m2" | "m3" | "adminA" | "adminB" | "sa";
const OWNERS: OwnerKey[] = ["m1", "m2", "m3", "adminA"];
const CHILD_OWNERS: Exclude<OwnerKey, "adminA">[] = ["m1", "m2", "m3"];
const ACTORS: ActorKey[] = ["m1", "m2", "m3", "adminA", "adminB", "sa"];

// WHO MAY SEE WHOSE RECORDS — the whole model in one table. Each row is an actor; the list is the
// owners whose leads/accounts that actor can reach. Team A = {adminA, m1, m2}, Team B = {adminB, m3}.
const SEES: Record<ActorKey, OwnerKey[]> = {
  m1: ["m1"],
  m2: ["m2"],
  m3: ["m3"],
  adminA: ["m1", "m2", "adminA"],
  adminB: ["m3"],
  sa: ["m1", "m2", "m3", "adminA"],
};

// ----- the world -------------------------------------------------------------------------------

// One company, Team A (adminA, m1, m2) and Team B (adminB, m3), a SUPER_ADMIN, and one lead plus
// one account per owner. m2 owns 2 leads and m3 owns 3 so every actor's aggregate is distinguishable
// by size. Children (task, account task, ask, cash entry, service fee, meetings) hang off m1/m2/m3
// with amounts 1/2/4 x 100 and 10/20/40, so any leaked row changes a total to a number no
// legitimate combination produces.
async function world() {
  const company = await makeCompany();
  const companyId = company.id;
  const teamA = await makeTeam({ companyId, name: "Team Alpha" });
  const teamB = await makeTeam({ companyId, name: "Team Bravo" });
  await seedTeamStages(testPrisma, companyId, teamA.id);
  await seedTeamStages(testPrisma, companyId, teamB.id);
  const A = await listStages(testPrisma, { companyId, teamId: teamA.id });
  const B = await listStages(testPrisma, { companyId, teamId: teamB.id });

  const U = {
    adminA: await makeUser("COMPANY_ADMIN", teamA, { name: "Aida Admin" }),
    m1: await makeUser("MEMBER", teamA, { name: "Mina One" }),
    m2: await makeUser("MEMBER", teamA, { name: "Mehdi Two" }),
    adminB: await makeUser("COMPANY_ADMIN", teamB, { name: "Bakhtiyar Admin" }),
    m3: await makeUser("MEMBER", teamB, { name: "Murad Three" }),
  };
  const saRow = await makeUser("SUPER_ADMIN", undefined, { name: "Owner" });
  const saInCompany = await testPrisma.user.update({ where: { id: saRow.id }, data: { companyId } });
  const S: Record<ActorKey, SessionUser> & { saNoCtx: SessionUser } = {
    adminA: su(U.adminA), m1: su(U.m1), m2: su(U.m2), adminB: su(U.adminB), m3: su(U.m3),
    sa: su(saInCompany),
    saNoCtx: su(saRow),
  };

  const open = { A: firstOfType(A, "OPEN"), B: firstOfType(B, "OPEN") };
  const leadSpec: [OwnerKey, string][] = [
    ["m1", "Bldg M1"], ["m2", "Bldg M2"], ["m2", "Bldg M2 second"],
    ["m3", "Bldg M3"], ["m3", "Bldg M3 second"], ["m3", "Bldg M3 third"],
    ["adminA", "Bldg AdminA"],
  ];
  const leads: Record<OwnerKey, Lead[]> = { m1: [], m2: [], m3: [], adminA: [] };
  for (const [k, name] of leadSpec) {
    const stage = k === "m3" ? open.B : open.A;
    leads[k].push(await createLead(testPrisma, S[k], {
      title: `Lead ${name}`, contactName: `Contact ${name}`, stageId: stage.id, companyName: name,
    }));
  }
  const accounts = {} as Record<OwnerKey, Account>;
  for (const k of OWNERS) accounts[k] = await createAccount(testPrisma, S[k], { name: `Acct ${k}` });

  const amount = { m1: 1, m2: 2, m3: 4 } as const;
  const tasks = {} as Record<(typeof CHILD_OWNERS)[number], { id: string }>;
  const acctTasks = {} as typeof tasks;
  const asks = {} as typeof tasks;
  const entries = {} as typeof tasks;
  const fees = {} as typeof tasks;
  for (const k of CHILD_OWNERS) {
    const a = accounts[k];
    tasks[k] = await testPrisma.task.create({ data: { companyId, leadId: leads[k][0].id, title: `task ${k}` } });
    acctTasks[k] = await testPrisma.accountTask.create({ data: { companyId, accountId: a.id, title: `acct task ${k}` } });
    asks[k] = await testPrisma.accountAsk.create({ data: { companyId, accountId: a.id, title: `ask ${k}`, authorId: U[k].id } });
    entries[k] = await testPrisma.settlementEntry.create({ data: {
      companyId, accountId: a.id, type: "TRANSFER", amount: amount[k] * 100, method: "CASH",
      occurredAt: new Date(), createdById: U[k].id,
    } });
    fees[k] = await testPrisma.serviceFee.create({ data: {
      companyId, accountId: a.id, periodMonth: new Date(Date.UTC(2026, 0, 1)), amount: amount[k] * 10,
      createdById: U[k].id,
    } });
    await testPrisma.activity.create({ data: {
      companyId, leadId: leads[k][0].id, authorId: U[k].id, kind: "MEETING", body: `lead meeting ${k}`,
    } });
    await testPrisma.accountActivity.create({ data: {
      companyId, accountId: a.id, authorId: U[k].id, kind: "MEETING", body: `acct meeting ${k}`,
    } });
  }
  // A task on m1's lead handed to the team admin: the admin's "my work" must show exactly this.
  const adminTask = await testPrisma.task.create({ data: {
    companyId, leadId: leads.m1[0].id, title: "assigned to adminA", assigneeId: U.adminA.id,
  } });

  return {
    company, companyId, teamA, teamB, stages: { A, B }, open, U, S, leads, accounts,
    tasks, acctTasks, asks, entries, fees, adminTask,
  };
}
type World = Awaited<ReturnType<typeof world>>;

// The representative for one owner's building. Created by that building's TEAM ADMIN, never by
// the owning member: minting a PARTNER_VIEWER is admin-only, because a PARTNER_VIEWER holds the
// capabilities a MEMBER is denied and a member who could mint one could log in as it. So the
// creator is adminA for Team A's buildings and adminB for m3's, over in Team B.
async function repFor(w: World, k: OwnerKey): Promise<{ row: User; session: SessionUser }> {
  const creator = k === "m3" ? w.S.adminB : w.S.adminA;
  const login = await createPartnerLogin(testPrisma, creator, w.accounts[k].id, {
    name: `Rep ${k}`, email: `${uniq("rep-")}@test.local`, password: "password123",
  });
  const row = await testPrisma.user.findUniqueOrThrow({ where: { id: login.id } });
  return { row, session: su(row) };
}

// ----- suite -----------------------------------------------------------------------------------

describe("team isolation", () => {
  let savedSecret: string | undefined;
  let savedKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedSecret = process.env.PARTNER_API_KEY_SECRET;
    savedKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
    // No global partner key => createAccount's auto-link resolver never touches the network.
    delete process.env.PARTNER_API_KEY;
    vi.mocked(fetchPartnerStats).mockReset();
    vi.mocked(fetchPartnerStats).mockImplementation(async (p) => makePartnerStats({ partner: p.partner }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockUser = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET;
    else process.env.PARTNER_API_KEY_SECRET = savedSecret;
    if (savedKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedKey;
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  // ===========================================================================================
  // 1. LEADS AND ACCOUNTS: list / get / update / delete, for every actor
  // ===========================================================================================
  describe("1. leads and accounts by id", () => {
    describe.each(ACTORS)("actor %s", (actorKey) => {
      it("get/update/delete a lead: reachable iff in scope, otherwise NotFound (never a filtered-empty 200)", async () => {
        const w = await world();
        const actor = w.S[actorKey];
        for (const owner of OWNERS) {
          const lead = w.leads[owner][0];
          const visible = SEES[actorKey].includes(owner);
          const tag = `${actorKey} -> lead of ${owner}`;

          const got = await getLead(testPrisma, actor, lead.id);
          expect(got?.id ?? null, `get ${tag}`).toBe(visible ? lead.id : null);

          expect(await outcome(() => updateLead(testPrisma, actor, lead.id, { title: "HACKED" })), `update ${tag}`)
            .toBe(visible ? "ok" : "NotFound");
          const afterUpdate = await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
          expect(afterUpdate.title, `title after update ${tag}`).toBe(visible ? "HACKED" : lead.title);

          expect(await outcome(() => deleteLead(testPrisma, actor, lead.id)), `delete ${tag}`)
            .toBe(visible ? "ok" : "NotFound");
          const stillThere = await testPrisma.lead.findUnique({ where: { id: lead.id } });
          expect(stillThere !== null, `row survives ${tag}`).toBe(!visible);
        }
      });

      it("get/update/delete an account: reachable iff in scope, otherwise NotFound", async () => {
        const w = await world();
        const actor = w.S[actorKey];
        for (const owner of OWNERS) {
          const acct = w.accounts[owner];
          const visible = SEES[actorKey].includes(owner);
          const tag = `${actorKey} -> account of ${owner}`;

          const got = await getAccount(testPrisma, actor, acct.id);
          expect(got?.id ?? null, `get ${tag}`).toBe(visible ? acct.id : null);

          expect(await outcome(() => updateAccount(testPrisma, actor, acct.id, { industry: "HACKED" })), `update ${tag}`)
            .toBe(visible ? "ok" : "NotFound");
          const afterUpdate = await testPrisma.account.findUniqueOrThrow({ where: { id: acct.id } });
          expect(afterUpdate.industry, `industry after update ${tag}`).toBe(visible ? "HACKED" : null);

          expect(await outcome(() => deleteAccount(testPrisma, actor, acct.id)), `delete ${tag}`)
            .toBe(visible ? "ok" : "NotFound");
          const stillThere = await testPrisma.account.findUnique({ where: { id: acct.id } });
          expect(stillThere !== null, `row survives ${tag}`).toBe(!visible);
        }
      });

      it("list leads, lead cards and accounts return exactly the in-scope rows", async () => {
        const w = await world();
        const actor = w.S[actorKey];
        const expectedLeads = SEES[actorKey].flatMap((o) => w.leads[o]);
        const expectedAccounts = SEES[actorKey].map((o) => w.accounts[o]);

        expect(sortIds(await listLeads(testPrisma, actor))).toEqual(sortIds(expectedLeads));
        expect(sorted((await listLeadCards(testPrisma, actor)).map((c) => c.id))).toEqual(sortIds(expectedLeads));
        expect(sortIds(await listAccounts(testPrisma, actor))).toEqual(sortIds(expectedAccounts));
      });

      it("caller-supplied filters can only narrow the scope, never widen it", async () => {
        const w = await world();
        const actor = w.S[actorKey];
        const visibleLeadIds = new Set(SEES[actorKey].flatMap((o) => w.leads[o]).map((l) => l.id));
        const visibleAcctIds = new Set(SEES[actorKey].map((o) => w.accounts[o].id));
        // Ask for every OTHER owner's rows explicitly, and for everything by text search.
        for (const owner of OWNERS) {
          for (const l of await listLeads(testPrisma, actor, { ownerId: w.U[owner].id })) {
            expect(visibleLeadIds.has(l.id), `ownerId=${owner} leaked lead ${l.title} to ${actorKey}`).toBe(true);
          }
        }
        for (const l of await listLeads(testPrisma, actor, { q: "Bldg" })) expect(visibleLeadIds.has(l.id)).toBe(true);
        for (const l of await listLeads(testPrisma, actor, { stageId: w.open.A.id })) expect(visibleLeadIds.has(l.id)).toBe(true);
        for (const l of await listLeads(testPrisma, actor, { stageId: w.open.B.id })) expect(visibleLeadIds.has(l.id)).toBe(true);
        for (const a of await listAccounts(testPrisma, actor, { q: "Acct" })) expect(visibleAcctIds.has(a.id)).toBe(true);
      });
    });

    // DEFECT D1 (reported, not fixed here): listAccounts() does `where.accountManagerId = opts.accountManagerId`,
    // which OVERWRITES the `accountManagerId: user.id` that accountScopeWhere pinned for a MEMBER.
    // This is the exact bug leads.ts fixed with scopedWhere() (AND-ing filters). Reachable over
    // HTTP: GET /api/accounts?accountManagerId=<teammate id>. Team still bounds it (teamId is not
    // overwritten), so the leak is teammate-level, not cross-team. `it.fails` keeps the assertion
    // strict: this test goes RED the moment the defect is fixed, at which point drop `.fails`.
    describe("DEFECT D1: accountManagerId filter vs MEMBER scope", () => {
      it("a member listing accounts with accountManagerId=<teammate> gets nothing of the teammate's", async () => {
        const w = await world();
        const rows = await listAccounts(testPrisma, w.S.m1, { accountManagerId: w.U.m2.id });
        expect(rows.map((a) => a.id)).not.toContain(w.accounts.m2.id);
      });

      it("control: the same filter cannot widen a team admin, a cross-team member or the other team", async () => {
        const w = await world();
        expect(await listAccounts(testPrisma, w.S.m3, { accountManagerId: w.U.m1.id })).toEqual([]);
        expect(await listAccounts(testPrisma, w.S.adminB, { accountManagerId: w.U.m1.id })).toEqual([]);
        expect(sortIds(await listAccounts(testPrisma, w.S.adminA, { accountManagerId: w.U.m1.id }))).toEqual([w.accounts.m1.id]);
        expect(await listAccounts(testPrisma, w.S.adminA, { accountManagerId: w.U.m3.id })).toEqual([]);
      });
    });

    it("a member cannot reach a TEAMMATE's records (same team is not enough)", async () => {
      const w = await world();
      expect(await getLead(testPrisma, w.S.m1, w.leads.m2[0].id)).toBeNull();
      expect(await getAccount(testPrisma, w.S.m1, w.accounts.m2.id)).toBeNull();
      expect(await outcome(() => updateLead(testPrisma, w.S.m1, w.leads.m2[0].id, { title: "x" }))).toBe("NotFound");
      expect(await outcome(() => updateAccount(testPrisma, w.S.m1, w.accounts.m2.id, { industry: "x" }))).toBe("NotFound");
      expect(await outcome(() => deleteLead(testPrisma, w.S.m1, w.leads.m2[0].id))).toBe("NotFound");
      expect(await outcome(() => deleteAccount(testPrisma, w.S.m1, w.accounts.m2.id))).toBe("NotFound");
    });

    it("a missing id and an out-of-scope id are indistinguishable (no id-probing oracle)", async () => {
      const w = await world();
      const missing = await caught(() => updateLead(testPrisma, w.S.m1, "no-such-lead", { title: "x" }));
      const foreign = await caught(() => updateLead(testPrisma, w.S.m1, w.leads.m3[0].id, { title: "x" }));
      expect(missing).toBeInstanceOf(NotFoundError);
      expect(foreign).toBeInstanceOf(NotFoundError);
      expect((foreign as Error).message).toBe((missing as Error).message);
      expect(errorResponse(foreign).status).toBe(404);
      const missingA = await caught(() => updateAccount(testPrisma, w.S.m1, "no-such-acct", { industry: "x" }));
      const foreignA = await caught(() => updateAccount(testPrisma, w.S.m1, w.accounts.m3.id, { industry: "x" }));
      expect((foreignA as Error).message).toBe((missingA as Error).message);
    });

    it("reassignment: only admins, only within their own team, only a SUPER_ADMIN across teams", async () => {
      const w = await world();
      // member cannot hand their own lead / account away
      expect(await outcome(() => updateLead(testPrisma, w.S.m1, w.leads.m1[0].id, { ownerId: w.U.m2.id }))).toBe("Forbidden");
      expect(await outcome(() => updateAccount(testPrisma, w.S.m1, w.accounts.m1.id, { accountManagerId: w.U.m2.id }))).toBe("Forbidden");
      // team admin cannot push work into the sibling team
      expect(await outcome(() => updateLead(testPrisma, w.S.adminA, w.leads.m1[0].id, { ownerId: w.U.m3.id }))).toBe("Forbidden");
      expect(await outcome(() => updateAccount(testPrisma, w.S.adminA, w.accounts.m1.id, { accountManagerId: w.U.m3.id }))).toBe("Forbidden");
      const l = await testPrisma.lead.findUniqueOrThrow({ where: { id: w.leads.m1[0].id } });
      expect(l.ownerId).toBe(w.U.m1.id);
      expect(l.teamId).toBe(w.teamA.id);
      // a team admin CAN move work between their own members
      expect(await outcome(() => updateLead(testPrisma, w.S.adminA, w.leads.m1[0].id, { ownerId: w.U.m2.id }))).toBe("ok");
      // a SUPER_ADMIN, PARTNER_VIEWER and deactivated user are never assignable owners
      const rep = await repFor(w, "m1");
      expect(await outcome(() => updateLead(testPrisma, w.S.adminA, w.leads.m2[0].id, { ownerId: rep.row.id }))).toBe("Forbidden");
      expect(await outcome(() => updateLead(testPrisma, w.S.adminA, w.leads.m2[0].id, { ownerId: w.S.sa.id }))).toBe("Forbidden");
    });

    it("a member creating records always owns them: a forged ownerId has no effect", async () => {
      const w = await world();
      const lead = await createLead(testPrisma, w.S.m1, {
        title: "t", contactName: "c", stageId: w.open.A.id, companyName: "Forged Owner Tower", ownerId: w.U.m3.id,
      });
      expect(lead.ownerId).toBe(w.U.m1.id);
      expect(lead.teamId).toBe(w.teamA.id);
      const acct = await createAccount(testPrisma, w.S.m1, { name: "Forged Mgr Tower", accountManagerId: w.U.m3.id });
      expect(acct.accountManagerId).toBe(w.U.m1.id);
      expect(acct.teamId).toBe(w.teamA.id);
    });

    it("SUPER_ADMIN without a company context fails closed on the CRM instead of widening", async () => {
      const w = await world();
      expect(await outcome(() => listLeads(testPrisma, w.S.saNoCtx))).toBe("Forbidden");
      expect(await outcome(() => getLead(testPrisma, w.S.saNoCtx, w.leads.m1[0].id))).toBe("Forbidden");
      expect(await outcome(() => listAccounts(testPrisma, w.S.saNoCtx))).toBe("Forbidden");
      expect(await outcome(() => getMyWork(testPrisma, w.S.saNoCtx))).toBe("Forbidden");
      expect(await outcome(() => getDashboardStats(testPrisma, w.S.saNoCtx, nowRange()))).toBe("Forbidden");
      // The one sanctioned path: a by-id account read resolves the account's own company.
      expect((await getAccount(testPrisma, w.S.saNoCtx, w.accounts.m3.id))?.id).toBe(w.accounts.m3.id);
    });
  });

  // ===========================================================================================
  // 2. BY-ID CHILD MUTATIONS must 404 out of scope
  // ===========================================================================================
  describe("2. by-id child mutations (the holes the refactor closed)", () => {
    type Op = {
      name: string;
      run: (w: World, actor: SessionUser, k: (typeof CHILD_OWNERS)[number], x: Extras) => Promise<unknown>;
      // true when the row was changed (or, for deletes, removed)
      mutated: (w: World, k: (typeof CHILD_OWNERS)[number], x: Extras) => Promise<boolean>;
    };
    type Extras = Record<(typeof CHILD_OWNERS)[number], { resolvedAsk: string; paidFee: string; editFee: string; delFee: string }>;

    // Extra rows so every op has a row whose "before" state makes the mutation observable.
    async function extras(w: World): Promise<Extras> {
      const out = {} as Extras;
      for (const k of CHILD_OWNERS) {
        const a = w.accounts[k];
        const base = { companyId: w.companyId, accountId: a.id, createdById: w.U[k].id, amount: 1 };
        const resolvedAsk = await testPrisma.accountAsk.create({ data: {
          companyId: w.companyId, accountId: a.id, title: "r", status: "RESOLVED", resolvedAt: new Date(),
        } });
        const paidFee = await testPrisma.serviceFee.create({ data: {
          ...base, periodMonth: new Date(Date.UTC(2026, 1, 1)), status: "PAID", paidAt: new Date(), method: "CASH",
        } });
        const editFee = await testPrisma.serviceFee.create({ data: { ...base, periodMonth: new Date(Date.UTC(2026, 2, 1)) } });
        const delFee = await testPrisma.serviceFee.create({ data: { ...base, periodMonth: new Date(Date.UTC(2026, 3, 1)) } });
        out[k] = { resolvedAsk: resolvedAsk.id, paidFee: paidFee.id, editFee: editFee.id, delFee: delFee.id };
      }
      return out;
    }

    const OPS: Op[] = [
      {
        name: "toggleTask",
        run: (w, a, k) => toggleTask(testPrisma, a, w.tasks[k].id, true),
        mutated: async (w, k) => (await testPrisma.task.findUniqueOrThrow({ where: { id: w.tasks[k].id } })).done,
      },
      {
        name: "toggleAccountTask",
        run: (w, a, k) => toggleAccountTask(testPrisma, a, w.acctTasks[k].id, true),
        mutated: async (w, k) => (await testPrisma.accountTask.findUniqueOrThrow({ where: { id: w.acctTasks[k].id } })).done,
      },
      {
        name: "resolveAsk",
        run: (w, a, k) => resolveAsk(testPrisma, a, w.asks[k].id),
        mutated: async (w, k) => (await testPrisma.accountAsk.findUniqueOrThrow({ where: { id: w.asks[k].id } })).status === "RESOLVED",
      },
      {
        name: "reopenAsk",
        run: (_w, a, k, x) => reopenAsk(testPrisma, a, x[k].resolvedAsk),
        mutated: async (_w, k, x) => (await testPrisma.accountAsk.findUniqueOrThrow({ where: { id: x[k].resolvedAsk } })).status === "OPEN",
      },
      // deleteSettlementEntry is NOT in this matrix: settlement writes are SUPER_ADMIN-only
      // (write_settlements), so every actor here is refused on ROLE before scope is consulted —
      // which this matrix would read as a leak-free pass for the wrong reason. Its scope
      // behaviour for the one role that CAN write is covered in ./settlements.test.ts.
      {
        name: "markFeePaid",
        run: (w, a, k) => markFeePaid(testPrisma, a, w.fees[k].id, {}),
        mutated: async (w, k) => (await testPrisma.serviceFee.findUniqueOrThrow({ where: { id: w.fees[k].id } })).status === "PAID",
      },
      {
        name: "markFeeUnpaid",
        run: (_w, a, k, x) => markFeeUnpaid(testPrisma, a, x[k].paidFee),
        mutated: async (_w, k, x) => (await testPrisma.serviceFee.findUniqueOrThrow({ where: { id: x[k].paidFee } })).status === "UNPAID",
      },
      {
        name: "updateServiceFee",
        run: (_w, a, k, x) => updateServiceFee(testPrisma, a, x[k].editFee, { amount: 999 }),
        mutated: async (_w, k, x) => (await testPrisma.serviceFee.findUniqueOrThrow({ where: { id: x[k].editFee } })).amount.toNumber() === 999,
      },
      {
        name: "deleteServiceFee",
        run: (_w, a, k, x) => deleteServiceFee(testPrisma, a, x[k].delFee),
        mutated: async (_w, k, x) => (await testPrisma.serviceFee.findUnique({ where: { id: x[k].delFee } })) === null,
      },
    ];

    describe.each(ACTORS)("actor %s", (actorKey) => {
      it("every by-id child mutation succeeds iff the PARENT is in scope, otherwise NotFound and nothing changes", async () => {
        const w = await world();
        const x = await extras(w);
        const actor = w.S[actorKey];
        for (const k of CHILD_OWNERS) {
          const visible = SEES[actorKey].includes(k);
          for (const op of OPS) {
            const tag = `${actorKey} ${op.name} on ${k}'s child`;
            expect(await outcome(() => op.run(w, actor, k, x)), tag).toBe(visible ? "ok" : "NotFound");
            expect(await op.mutated(w, k, x), `${tag}: row changed?`).toBe(visible);
          }
        }
      });
    });

    it("'no such id' and 'not your parent' return the SAME error for every op (no oracle)", async () => {
      const w = await world();
      const x = await extras(w);
      const ghost = "does-not-exist";
      const pairs: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
        ["toggleTask", () => toggleTask(testPrisma, w.S.m1, ghost, true), () => toggleTask(testPrisma, w.S.m1, w.tasks.m2.id, true)],
        ["toggleAccountTask", () => toggleAccountTask(testPrisma, w.S.m1, ghost, true), () => toggleAccountTask(testPrisma, w.S.m1, w.acctTasks.m2.id, true)],
        ["resolveAsk", () => resolveAsk(testPrisma, w.S.m1, ghost), () => resolveAsk(testPrisma, w.S.m1, w.asks.m2.id)],
        ["reopenAsk", () => reopenAsk(testPrisma, w.S.m1, ghost), () => reopenAsk(testPrisma, w.S.m1, x.m2.resolvedAsk)],
        ["markFeePaid", () => markFeePaid(testPrisma, w.S.m1, ghost, {}), () => markFeePaid(testPrisma, w.S.m1, w.fees.m2.id, {})],
        ["markFeeUnpaid", () => markFeeUnpaid(testPrisma, w.S.m1, ghost), () => markFeeUnpaid(testPrisma, w.S.m1, x.m2.paidFee)],
        ["updateServiceFee", () => updateServiceFee(testPrisma, w.S.m1, ghost, { amount: 1 }), () => updateServiceFee(testPrisma, w.S.m1, x.m2.editFee, { amount: 1 })],
        ["deleteServiceFee", () => deleteServiceFee(testPrisma, w.S.m1, ghost), () => deleteServiceFee(testPrisma, w.S.m1, x.m2.delFee)],
      ];
      for (const [name, missing, foreign] of pairs) {
        const a = await caught(missing);
        const b = await caught(foreign);
        expect(a, `${name} missing`).toBeInstanceOf(NotFoundError);
        expect(b, `${name} foreign`).toBeInstanceOf(NotFoundError);
        expect((b as Error).message, `${name} message`).toBe((a as Error).message);
      }
    });

    it("an assignee outside the lead's visible set cannot be handed a task", async () => {
      const w = await world();
      // m2 is a teammate of m1 but cannot open m1's lead; m3 is on the other team.
      expect(await outcome(() => addTask(testPrisma, w.S.m1, w.leads.m1[0].id, { title: "t", assigneeId: w.U.m2.id }))).toBe("Forbidden");
      expect(await outcome(() => addTask(testPrisma, w.S.m1, w.leads.m1[0].id, { title: "t", assigneeId: w.U.m3.id }))).toBe("Forbidden");
      expect(await outcome(() => addTask(testPrisma, w.S.m1, w.leads.m1[0].id, { title: "t", assigneeId: w.U.adminB.id }))).toBe("Forbidden");
      // the owner and their own team's admin are fine
      expect(await outcome(() => addTask(testPrisma, w.S.m1, w.leads.m1[0].id, { title: "t", assigneeId: w.U.adminA.id }))).toBe("ok");
      expect(await outcome(() => addTask(testPrisma, w.S.m1, w.leads.m1[0].id, { title: "t", assigneeId: w.U.m1.id }))).toBe("ok");
      // and nobody can add a task to a lead they cannot see
      expect(await outcome(() => addTask(testPrisma, w.S.m1, w.leads.m2[0].id, { title: "t" }))).toBe("NotFound");
    });

    it("a missing/foreign parent also blocks the by-parent reads (no empty-200 masquerading)", async () => {
      const w = await world();
      // A MEMBER has no view_settlements, so this is a role refusal before any scope check.
      expect(await outcome(() => getAccountSettlement(testPrisma, w.S.m1, w.accounts.m2.id))).toBe("Forbidden");
      expect(await outcome(() => getAccountSettlement(testPrisma, w.S.adminB, w.accounts.m1.id))).toBe("NotFound");
      expect(await outcome(() => getAccountSettlement(testPrisma, w.S.adminA, w.accounts.m1.id))).toBe("ok");
    });
  });

  // ===========================================================================================
  // 3. AGGREGATES leak nothing
  // ===========================================================================================
  describe("3. aggregates", () => {
    const WORK_PARENTS: Record<ActorKey, OwnerKey[]> = {
      m1: ["m1"], m2: ["m2"], m3: ["m3"], adminA: [], adminB: [], sa: [],
    };

    describe.each(ACTORS)("actor %s", (actorKey) => {
      it("getMyWork contains only this person's work on records inside their scope", async () => {
        const w = await world();
        const work = await getMyWork(testPrisma, w.S[actorKey]);
        const own = WORK_PARENTS[actorKey];
        const expectedParents = sorted(own.flatMap((k) => [w.leads[k][0].id, w.accounts[k].id]));
        const expectedTaskParents = actorKey === "adminA" ? [w.leads.m1[0].id] : expectedParents;
        expect(sorted(work.tasks.map((t) => t.parentId)), "task parents").toEqual(expectedTaskParents);
        expect(sorted(work.meetings.map((m) => m.parentId)), "meeting parents").toEqual(expectedParents);
      });

      it("dashboard counts reflect only in-scope records", async () => {
        const w = await world();
        const stats = await getDashboardStats(testPrisma, w.S[actorKey], nowRange());
        const sees = SEES[actorKey];
        const leadCount = sees.reduce((n, k) => n + w.leads[k].length, 0);
        const childSees = sees.filter((k): k is (typeof CHILD_OWNERS)[number] => k !== "adminA");
        const cash = childSees.reduce((n, k) => n + { m1: 100, m2: 200, m3: 400 }[k], 0);
        const outstanding = childSees.reduce((n, k) => n + { m1: 10, m2: 20, m3: 40 }[k], 0);
        // Two open tasks per child owner (lead task + account task), plus the one handed to adminA
        // on m1's lead, which belongs to m1's book.
        const openTasks = childSees.length * 2 + (sees.includes("m1") ? 1 : 0);
        expect(stats.sales.openLeads).toBe(leadCount);
        expect(stats.partners.accounts).toBe(sees.length);
        expect(stats.activity.meetingsDone).toBe(childSees.length * 2);
        expect(stats.activity.openTasks).toBe(openTasks);
        expect(stats.finance.serviceFeesOutstanding).toBe(outstanding);
        // Cash: a MEMBER has no view_settlements, so the figures are ABSENT from the DTO (never 0,
        // which would read as a real balance) while the general statistics above still render. For
        // the roles that do hold it, the fixture's 1/2/4 x 100 rows are TRANSFERS and Collected is
        // live card takings — 0 here, since these fixture accounts have no confirmed partner link
        // (same as the settlements roll-up test below; this assertion used to encode the removed
        // COLLECTED entry type, which is why it still expected `collected` to be the cash sum).
        if (w.S[actorKey].role === "MEMBER") {
          expect(stats.finance.collected).toBeUndefined();
          expect(stats.finance.transferred).toBeUndefined();
          expect(stats.finance.owed).toBeUndefined();
        } else {
          // CHANGED ON PURPOSE: these accounts have no confirmed partner link, so their Collected
          // is UNKNOWN and no longer folded in as 0 — which means Owed is no longer -Transferred
          // (a figure that read as "the partners owe us that much back"). Collected/Owed sum only
          // the accounts that answered — none here — while Transferred stays the full, known total.
          expect(stats.finance.collected).toBe(0);
          expect(stats.finance.transferred).toBe(cash);
          expect(stats.finance.owed).toBe(0);
        }
      });

      it("company settlements and service fees list only in-scope accounts, with matching totals", async () => {
        const w = await world();
        const sees = SEES[actorKey];
        const fees = await listCompanyServiceFees(testPrisma, w.S[actorKey]);
        expect(sorted(fees.rows.map((r) => r.accountId))).toEqual(sorted(sees.map((k) => w.accounts[k].id)));
        const rowSum = (n: number[]) => n.reduce((a, b) => a + b, 0);
        expect(fees.totals.billed).toBe(rowSum(fees.rows.map((r) => r.billed)));
        const expectedBilled = sees.reduce((n, k) => n + ({ m1: 10, m2: 20, m3: 40, adminA: 0 }[k]), 0);
        expect(fees.totals.billed).toBe(expectedBilled);

        // Settlements are gated on view_settlements, which a MEMBER does not hold — the roll-up
        // is refused outright rather than narrowed. For the roles that do hold it, the scope is
        // still the test's `sees` set, Collected is 0 (these fixture accounts have no confirmed
        // partner link, so nothing is fetched) and the fixture rows count as transfers.
        if (w.S[actorKey].role === "MEMBER") {
          expect(await outcome(() => listCompanySettlements(testPrisma, w.S[actorKey]))).toBe("Forbidden");
        } else {
          const settlements = await listCompanySettlements(testPrisma, w.S[actorKey]);
          expect(sorted(settlements.rows.map((r) => r.accountId))).toEqual(sorted(sees.map((k) => w.accounts[k].id)));
          expect(settlements.totals.transferred).toBe(rowSum(settlements.rows.map((r) => r.transferred)));
          expect(settlements.totals.collected).toBe(0);
          // ...and because nothing was fetched, the roll-up declares itself incomplete rather than
          // letting a 0 Collected pass as "these partners collected nothing".
          expect(settlements.totals.partial).toBe(settlements.rows.length > 0);
          expect(settlements.totals.transferred).toBe(
            sees.reduce((n, k) => n + ({ m1: 100, m2: 200, m3: 400, adminA: 0 }[k]), 0),
          );
        }
      });
    });

    it("an assignment that survives a lead's move to a teammate does not surface the teammate's lead title", async () => {
      // An admin reassigns m1's lead to m2 inside the team. The OPEN task still assigned to m1
      // stays assigned to m1 (clearUnseeableAssignees only runs on a cross-TEAM transfer). m1 now
      // cannot open the lead, so its title must not appear in m1's "my work".
      const w = await world();
      const stale = await testPrisma.task.create({ data: {
        companyId: w.companyId, leadId: w.leads.m1[0].id, title: "stale assignment", assigneeId: w.U.m1.id,
      } });
      await updateLead(testPrisma, w.S.adminA, w.leads.m1[0].id, { ownerId: w.U.m2.id });
      const work = await getMyWork(testPrisma, w.S.m1);
      expect(work.tasks.map((t) => t.id)).not.toContain(stale.id);
      expect(work.tasks.map((t) => t.parentTitle)).not.toContain(w.leads.m1[0].title);
    });

    // THE OTHER HALF OF THE SAME LEAK, and the one the stale marker above used to hide. A task
    // assignment is cleared when the record is reassigned (updateLead/updateAccount both drop open
    // assignments the new owner's circle cannot see), but AUTHORSHIP of an Activity is permanent
    // history and can never be cleared. getMyWork's meeting queries matched on `authorId: me`
    // under a parent filter with `ownerId`/`accountManagerId` STRIPPED OUT, so a member kept
    // reading the LIVE title of every lead, and the live name of every account, in their team on
    // which they had ever logged a meeting — including after it moved to a teammate and was
    // renamed. Both Activity and AccountActivity are asserted; both arms had the same hole.
    it("a meeting I logged does not surface a teammate's live lead title or account name after reassignment", async () => {
      const w = await world();
      const leadId = w.leads.m1[0].id;
      const accountId = w.accounts.m1.id;
      // world() already logged `lead meeting m1` / `acct meeting m1`, both authored by m1, on
      // exactly these two records — i.e. m1 is the author and was the owner at the time.

      // The team admin hands both to m2, who then renames them.
      await updateLead(testPrisma, w.S.adminA, leadId, { ownerId: w.U.m2.id });
      await updateAccount(testPrisma, w.S.adminA, accountId, { accountManagerId: w.U.m2.id });
      await updateLead(testPrisma, w.S.m2, leadId, { title: "SECRET RENAMED LEAD" });
      await updateAccount(testPrisma, w.S.m2, accountId, { name: "SECRET RENAMED BUILDING" });

      // m1 404s on both records now — so nothing about them may appear in m1's "my work".
      expect(await getLead(testPrisma, w.S.m1, leadId)).toBeNull();
      expect(await getAccount(testPrisma, w.S.m1, accountId)).toBeNull();

      const work = await getMyWork(testPrisma, w.S.m1);
      const rows = [...work.tasks, ...work.meetings];
      expect(rows.map((r) => r.parentId), "m1 parent ids").not.toContain(leadId);
      expect(rows.map((r) => r.parentId), "m1 parent ids").not.toContain(accountId);
      expect(rows.map((r) => r.parentTitle), "m1 parent titles").not.toContain("SECRET RENAMED LEAD");
      expect(rows.map((r) => r.parentTitle), "m1 parent titles").not.toContain("SECRET RENAMED BUILDING");

      // ...and the rows are not simply gone: m2, who owns both records now, sees the same two
      // meetings under their new names. The scope decides, not the authorship.
      const m2work = await getMyWork(testPrisma, w.S.m2);
      expect(m2work.meetings.filter((m) => m.parentId === leadId).map((m) => m.body))
        .toEqual(["lead meeting m1"]);
      expect(m2work.meetings.find((m) => m.parentId === leadId)?.parentTitle)
        .toBe("SECRET RENAMED LEAD");
      expect(m2work.meetings.filter((m) => m.parentId === accountId).map((m) => m.body))
        .toEqual(["acct meeting m1"]);
      expect(m2work.meetings.find((m) => m.parentId === accountId)?.parentTitle)
        .toBe("SECRET RENAMED BUILDING");
    });

    it("a task assigned to a member on another TEAM's lead never surfaces", async () => {
      const w = await world();
      const t = await testPrisma.task.create({ data: {
        companyId: w.companyId, leadId: w.leads.m3[0].id, title: "cross-team assignment", assigneeId: w.U.m1.id,
      } });
      const work = await getMyWork(testPrisma, w.S.m1);
      expect(work.tasks.map((x) => x.id)).not.toContain(t.id);
    });

    it("report rows, payments, CSV and the live API fan-out are confined to the caller's accounts", async () => {
      const w = await world();
      process.env.PARTNER_API_KEY = "shared-test-key";
      for (const k of OWNERS) {
        await testPrisma.account.update({ where: { id: w.accounts[k].id }, data: confirmedPartnerLink(`partner-${k}`) });
      }
      vi.mocked(fetchPartnerStats).mockImplementation(async (p) =>
        makePartnerStats({
          partner: p.partner, total_payments_count: 1, total_payments_amount: 50,
          payments: [makePartnerPayment({ id: `pay-${p.partner}`, user_name: `payer-${p.partner}`, amount: 50 })],
          payments_total_count: 1,
        }),
      );
      for (const actorKey of ACTORS) {
        vi.mocked(fetchPartnerStats).mockClear();
        const visible = SEES[actorKey];
        const report = await getReport(testPrisma, w.S[actorKey], { range: nowRange(), label: "now" });
        expect(sorted(report.partnerRows.map((r) => r.accountId)), `${actorKey} rows`).toEqual(sorted(visible.map((k) => w.accounts[k].id)));
        if (actorKey.startsWith("m")) {
          // MEMBER: no payment rows (and no payer names) anywhere in the payload.
          expect(report.payments, `${actorKey} payments`).toBeUndefined();
          expect(JSON.stringify(report), `${actorKey} payer identity`).not.toContain("payer-partner-");
        } else {
          expect(sorted(report.payments!.map((p) => p.id)), `${actorKey} payments`).toEqual(sorted(visible.map((k) => `pay-partner-${k}`)));
        }
        expect(sorted(report.accountStatuses.map((s) => s.accountId)), `${actorKey} statuses`).toEqual(sorted(visible.map((k) => w.accounts[k].id)));
        // The strongest form: a foreign partner is never even REQUESTED from the upstream API.
        const requested = new Set(vi.mocked(fetchPartnerStats).mock.calls.map((c) => c[0].partner));
        expect(sorted([...requested]), `${actorKey} upstream calls`).toEqual(sorted(visible.map((k) => `partner-${k}`)));
        const csv = toCsv(report);
        for (const k of OWNERS) {
          if (!visible.includes(k)) {
            expect(csv, `${actorKey} CSV mentions ${k}'s account`).not.toContain(w.accounts[k].name);
            expect(csv).not.toContain(`pay-partner-${k}`);
          }
        }
        // The report's embedded KPIs are the same numbers the dashboard shows.
        const dash = await getDashboardStats(testPrisma, w.S[actorKey], nowRange());
        expect(report.kpis.partners.accounts).toBe(dash.partners.accounts);
        expect(report.kpis.finance.collected).toBe(dash.finance.collected);
      }
    });

    it("a single-partner report for an account outside scope is NotFound", async () => {
      const w = await world();
      const r = (actor: SessionUser, accountId: string) =>
        getReport(testPrisma, actor, { range: nowRange(), label: "x", accountId });
      expect(await outcome(() => r(w.S.m1, w.accounts.m2.id))).toBe("NotFound");
      expect(await outcome(() => r(w.S.m1, w.accounts.m3.id))).toBe("NotFound");
      expect(await outcome(() => r(w.S.adminB, w.accounts.m1.id))).toBe("NotFound");
      expect(await outcome(() => r(w.S.m1, w.accounts.m1.id))).toBe("ok");
      expect(await outcome(() => r(w.S.adminA, w.accounts.m2.id))).toBe("ok");
      expect(await outcome(() => r(w.S.sa, w.accounts.m3.id))).toBe("ok");
    });

    describe("users", () => {
      it("listUsers: members and partners are refused; admins see their team plus its buildings' reps; SA sees all", async () => {
        const w = await world();
        const repM1 = await repFor(w, "m1");
        const repM3 = await repFor(w, "m3");
        const everyone = await testPrisma.user.findMany({ where: { companyId: w.companyId } });

        expect(await outcome(() => listUsers(testPrisma, w.S.m1))).toBe("Forbidden");
        expect(await outcome(() => listUsers(testPrisma, repM1.session))).toBe("Forbidden");

        expect(sortIds(await listUsers(testPrisma, w.S.adminA)))
          .toEqual(sorted([w.U.adminA.id, w.U.m1.id, w.U.m2.id, repM1.row.id]));
        expect(sortIds(await listUsers(testPrisma, w.S.adminB)))
          .toEqual(sorted([w.U.adminB.id, w.U.m3.id, repM3.row.id]));
        expect(sortIds(await listUsers(testPrisma, w.S.sa))).toEqual(sortIds(everyone));

        // naming the other team is refused, not silently substituted
        expect(await outcome(() => listUsers(testPrisma, w.S.adminA, { teamId: w.teamB.id }))).toBe("Forbidden");
      });

      it("listAssignableUsers: a member is offered only themself; admins only their own team's people", async () => {
        const w = await world();
        const repM1 = await repFor(w, "m1");
        expect(sortIds(await listAssignableUsers(testPrisma, w.S.m1))).toEqual([w.U.m1.id]);
        expect(sortIds(await listAssignableUsers(testPrisma, w.S.adminA)))
          .toEqual(sorted([w.U.adminA.id, w.U.m1.id, w.U.m2.id]));
        expect(sortIds(await listAssignableUsers(testPrisma, w.S.adminB))).toEqual(sorted([w.U.adminB.id, w.U.m3.id]));
        expect(sortIds(await listAssignableUsers(testPrisma, w.S.sa)))
          .toEqual(sorted([w.U.adminA.id, w.U.m1.id, w.U.m2.id, w.U.adminB.id, w.U.m3.id]));
        expect(await outcome(() => listAssignableUsers(testPrisma, repM1.session))).toBe("Forbidden");
      });

      it("getUser / setUserStatus / createUser cannot cross the team boundary", async () => {
        const w = await world();
        const repM3 = await repFor(w, "m3");
        expect(await getUser(testPrisma, w.S.adminA, w.U.m3.id)).toBeNull();
        expect(await getUser(testPrisma, w.S.adminA, repM3.row.id)).toBeNull();
        expect((await getUser(testPrisma, w.S.adminA, w.U.m1.id))?.id).toBe(w.U.m1.id);
        expect(await outcome(() => setUserStatus(testPrisma, w.S.adminA, w.U.m3.id, "INACTIVE"))).toBe("NotFound");
        expect((await testPrisma.user.findUniqueOrThrow({ where: { id: w.U.m3.id } })).status).toBe("ACTIVE");

        const mk = (actor: SessionUser, over: Partial<Parameters<typeof createUser>[2]>) =>
          createUser(testPrisma, actor, { name: "N", email: `${uniq("n-")}@t.local`, password: "password123", role: "MEMBER", ...over });
        expect(await outcome(() => mk(w.S.adminA, { teamId: w.teamB.id }))).toMatch(/^other:InvalidUserRoleError/);
        expect(await outcome(() => mk(w.S.adminA, { role: "PARTNER_VIEWER", accountId: w.accounts.m3.id }))).toMatch(/^other:InvalidUserRoleError/);
        expect(await outcome(() => mk(w.S.adminA, { role: "COMPANY_ADMIN" }))).toBe("Forbidden");
        expect(await outcome(() => mk(w.S.m1, {}))).toBe("Forbidden");
        expect(await outcome(() => mk(w.S.sa, { role: "SUPER_ADMIN" }))).toMatch(/^other:InvalidUserRoleError/);
        // control: own team is fine, and lands on the admin's team
        const ok = await mk(w.S.adminA, {});
        expect(ok.teamId).toBe(w.teamA.id);
        expect(InvalidUserRoleError).toBeDefined();
      });
    });
  });

  // ===========================================================================================
  // 4. PARTNER LOGINS
  // ===========================================================================================
  describe("4. partner logins", () => {
    it("the TEAM ADMIN creates the representative for a member's account; the row is a team-less partner pinned to it", async () => {
      const w = await world();
      const { row } = await repFor(w, "m1");
      expect(row.role).toBe("PARTNER_VIEWER");
      expect(row.accountId).toBe(w.accounts.m1.id);
      expect(row.teamId).toBeNull();
      expect(row.companyId).toBe(w.companyId);
      expect(row.status).toBe("ACTIVE");
    });

    // The member who MANAGES the building cannot mint its login — this is the privilege
    // escalation the branch closed. A PARTNER_VIEWER may read settlements, payment detail and
    // object detail, all of which a MEMBER is refused, so a member who could mint one with a
    // password of their choosing could log in as it and read straight past their own gate.
    // Scope does not help: the building genuinely is theirs.
    it("the account's OWN member is Forbidden from minting its representative, and mints nothing", async () => {
      const w = await world();
      const login = { name: "Rep", email: `${uniq("rep-")}@t.local`, password: "password123" };
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m1, w.accounts.m1.id, login))).toBe("Forbidden");
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m3, w.accounts.m3.id, login))).toBe("Forbidden");
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.adminA, w.accounts.adminA.id, login))).toBe("ok");
      // Exactly the admin's one row exists; neither member's attempt wrote anything.
      const reps = await testPrisma.user.findMany({ where: { role: "PARTNER_VIEWER" } });
      expect(reps.map((r) => r.accountId)).toEqual([w.accounts.adminA.id]);
    });

    // The ROLE gate sits AFTER getAccount on purpose. A member naming an id outside their scope
    // must get the same NotFound as a member naming an id that does not exist — if the role
    // refusal came first, the two answers would differ and the call would confirm which ids are
    // real. Both members below are refused, but for the in-scope-but-unauthorized case only.
    it("ordering: out of scope stays NotFound for a member, it does not become Forbidden", async () => {
      const w = await world();
      const login = { name: "Rep", email: `${uniq("rep-")}@t.local`, password: "password123" };
      // m1 cannot see m2's (same team) or m3's (other team) account: NotFound, not Forbidden.
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m1, w.accounts.m2.id, login))).toBe("NotFound");
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m1, w.accounts.m3.id, login))).toBe("NotFound");
      // ...the same answer a wholly made-up id gets, which is what makes it not an oracle.
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m1, "no-such-account-id", login))).toBe("NotFound");
      // Only the account m1 CAN see turns into the role refusal.
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m1, w.accounts.m1.id, login))).toBe("Forbidden");
      expect(await testPrisma.user.count({ where: { role: "PARTNER_VIEWER" } })).toBe(0);
    });

    it("refused on a teammate's account and on another team's account (404), and creates nothing", async () => {
      const w = await world();
      const login = { name: "Rep", email: `${uniq("rep-")}@t.local`, password: "password123" };
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m1, w.accounts.m2.id, login))).toBe("NotFound");
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.m1, w.accounts.m3.id, login))).toBe("NotFound");
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.adminB, w.accounts.m1.id, login))).toBe("NotFound");
      expect(await outcome(() => listPartnerLogins(testPrisma, w.S.m1, w.accounts.m2.id))).toBe("NotFound");
      expect(await testPrisma.user.count({ where: { role: "PARTNER_VIEWER" } })).toBe(0);
      // control: the team admin may do it for any account in their team, the SA for any account
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.adminA, w.accounts.m2.id, login))).toBe("ok");
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.sa, w.accounts.m3.id, { ...login, email: `${uniq("rep-")}@t.local` }))).toBe("ok");
    });

    it("only one ACTIVE representative per account; a deactivated one can be replaced", async () => {
      const w = await world();
      const first = await repFor(w, "m1");
      const again = { name: "Second", email: `${uniq("rep-")}@t.local`, password: "password123" };
      // adminA, not m1: a member's attempt would be refused by the role gate and never reach the
      // one-active-login rule this test is about.
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.adminA, w.accounts.m1.id, again))).toBe("LoginExists");
      expect(await testPrisma.user.count({ where: { accountId: w.accounts.m1.id, role: "PARTNER_VIEWER" } })).toBe(1);
      await setUserStatus(testPrisma, w.S.adminA, first.row.id, "INACTIVE");
      expect(await outcome(() => createPartnerLogin(testPrisma, w.S.adminA, w.accounts.m1.id, again))).toBe("ok");
    });

    it("HTTP: admin 201 then 409, other team's 404, member 403, partner 403", async () => {
      const w = await world();
      const post = (accountId: string) =>
        POST_PARTNER_LOGIN(
          new NextRequest("http://localhost/api/accounts/x/partner-login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Rep", email: `${uniq("rep-")}@t.local`, password: "password123" }),
          }),
          { params: Promise.resolve({ id: accountId }) },
        );
      // POST is assertRole(["COMPANY_ADMIN"]) — a MEMBER is 403 even on the building they
      // manage, and the route's role check runs before the body is parsed, so the refusal never
      // becomes a 400 about the payload.
      mockUser = w.S.m1;
      expect((await post(w.accounts.m1.id)).status).toBe(403);
      expect(await testPrisma.user.count({ where: { role: "PARTNER_VIEWER" } })).toBe(0);

      mockUser = w.S.adminA;
      expect((await post(w.accounts.m1.id)).status).toBe(201);
      expect((await post(w.accounts.m1.id)).status).toBe(409); // one ACTIVE login per account
      expect((await post(w.accounts.m3.id)).status).toBe(404); // Team B's building, out of scope
      const rep = await testPrisma.user.findFirstOrThrow({ where: { accountId: w.accounts.m1.id, role: "PARTNER_VIEWER" } });
      mockUser = su(rep);
      expect((await post(w.accounts.m1.id)).status).toBe(403); // a partner cannot mint a second login
    });

    describe("a partner reaches only its own building", () => {
      it("account reads: own yes, every other account null/NotFound", async () => {
        const w = await world();
        const rep = await repFor(w, "m1");
        const p = rep.session;
        expect((await getAccount(testPrisma, p, w.accounts.m1.id))?.id).toBe(w.accounts.m1.id);
        for (const k of ["m2", "m3", "adminA"] as const) {
          expect(await getAccount(testPrisma, p, w.accounts[k].id), `account ${k}`).toBeNull();
        }
        expect(sortIds(await listAccounts(testPrisma, p))).toEqual([w.accounts.m1.id]);
        expect(await outcome(() => getAccountSettlement(testPrisma, p, w.accounts.m1.id))).toBe("ok");
        expect(await outcome(() => getAccountSettlement(testPrisma, p, w.accounts.m2.id))).toBe("NotFound");
        expect(await outcome(() => getAccountFields(testPrisma, p, w.accounts.m2.id))).toBe("NotFound");
        expect(sorted((await listCompanySettlements(testPrisma, p)).rows.map((r) => r.accountId))).toEqual([w.accounts.m1.id]);
        expect(sorted((await listCompanyServiceFees(testPrisma, p)).rows.map((r) => r.accountId))).toEqual([w.accounts.m1.id]);
        // Collected is the partner API's card total, and this account has no confirmed partner
        // link, so it is 0; the fixture row is a TRANSFER and shows up as such.
        expect((await listCompanySettlements(testPrisma, p)).totals.collected).toBe(0);
        expect((await listCompanySettlements(testPrisma, p)).totals.transferred).toBe(100);
      });

      it("by-id child mutations on another building are NotFound and change nothing", async () => {
        const w = await world();
        const p = (await repFor(w, "m1")).session;
        expect(await outcome(() => toggleAccountTask(testPrisma, p, w.acctTasks.m2.id, true))).toBe("NotFound");
        expect(await outcome(() => resolveAsk(testPrisma, p, w.asks.m3.id))).toBe("NotFound");
        expect(await outcome(() => deleteSettlementEntry(testPrisma, p, w.entries.m2.id))).toBe("Forbidden");
        expect(await outcome(() => markFeePaid(testPrisma, p, w.fees.m3.id, {}))).toBe("NotFound");
        expect((await testPrisma.accountTask.findUniqueOrThrow({ where: { id: w.acctTasks.m2.id } })).done).toBe(false);
        expect(await testPrisma.settlementEntry.count({ where: { id: w.entries.m2.id } })).toBe(1);
        expect((await testPrisma.serviceFee.findUniqueOrThrow({ where: { id: w.fees.m3.id } })).status).toBe("UNPAID");
      });

      it("is forbidden from the whole sales side: leads, work, dashboard, users, stages, fields, conversion", async () => {
        const w = await world();
        const p = (await repFor(w, "m1")).session;
        const lead = w.leads.m1[0];
        const checks: [string, () => Promise<unknown>][] = [
          ["listLeads", () => listLeads(testPrisma, p)],
          ["listLeadCards", () => listLeadCards(testPrisma, p)],
          ["getLead", () => getLead(testPrisma, p, lead.id)],
          ["createLead", () => createLead(testPrisma, p, { title: "t", contactName: "c", stageId: w.open.A.id, companyName: "Partner Made" })],
          ["updateLead", () => updateLead(testPrisma, p, lead.id, { title: "x" })],
          ["deleteLead", () => deleteLead(testPrisma, p, lead.id)],
          ["moveLeadStage", () => moveLeadStage(testPrisma, p, lead.id, stageOf(w.stages.A, "Won").id)],
          ["convertLeadToAccount", () => convertLeadToAccount(testPrisma, p, lead.id)],
          ["toggleTask", () => toggleTask(testPrisma, p, w.tasks.m1.id, true)],
          ["addTask", () => addTask(testPrisma, p, lead.id, { title: "t" })],
          ["getMyWork", () => getMyWork(testPrisma, p)],
          ["getDashboardStats", () => getDashboardStats(testPrisma, p, nowRange())],
          ["getReport", () => getReport(testPrisma, p, { range: nowRange(), label: "x" })],
          ["listUsers", () => listUsers(testPrisma, p)],
          ["listAssignableUsers", () => listAssignableUsers(testPrisma, p)],
          ["createUser", () => createUser(testPrisma, p, { name: "n", email: `${uniq("n-")}@t.local`, password: "password123", role: "MEMBER" })],
          ["resolveStageScope", () => resolveStageScope(testPrisma, p)],
          ["resolveFieldDefScope", () => resolveFieldDefScope(testPrisma, p)],
          ["listFieldDefs", async () => listFieldDefs(testPrisma, p)],
          ["createAccount", () => createAccount(testPrisma, p, { name: "Partner Made Acct" })],
        ];
        for (const [name, fn] of checks) {
          expect(await outcome(fn), name).toBe("Forbidden");
        }
        expect(await testPrisma.lead.count({ where: { id: lead.id } })).toBe(1);
        expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).title).toBe(lead.title);
      });

      it("a partner with no accountId (data bug) sees nothing at all", async () => {
        const w = await world();
        const orphan: SessionUser = { id: "x", companyId: w.companyId, teamId: null, role: "PARTNER_VIEWER", accountId: null };
        for (const k of OWNERS) expect(await getAccount(testPrisma, orphan, w.accounts[k].id)).toBeNull();
        expect(await listAccounts(testPrisma, orphan)).toEqual([]);
        expect((await listCompanySettlements(testPrisma, orphan)).rows).toEqual([]);
      });
    });
  });

  // ===========================================================================================
  // 5. CONVERSION
  // ===========================================================================================
  describe("5. conversion inherits the lead's owner AND team", () => {
    const won = (w: World) => stageOf(w.stages.A, "Won");
    const wonB = (w: World) => stageOf(w.stages.B, "Won");

    it("a member converting their own lead: manager and team are theirs", async () => {
      const w = await world();
      const r = await moveLeadStage(testPrisma, w.S.m1, w.leads.m1[0].id, won(w).id);
      expect(r.autoConverted).toBe(true);
      const acct = await testPrisma.account.findUniqueOrThrow({ where: { sourceLeadId: w.leads.m1[0].id } });
      expect(acct.accountManagerId).toBe(w.U.m1.id);
      expect(acct.teamId).toBe(w.teamA.id);
      expect(acct.companyId).toBe(w.companyId);
    });

    it("a team admin converting a MEMBER's lead: the account stays the member's, in the member's team (not re-homed under the admin)", async () => {
      const w = await world();
      const r = await moveLeadStage(testPrisma, w.S.adminA, w.leads.m2[0].id, won(w).id);
      expect(r.autoConverted).toBe(true);
      const acct = await testPrisma.account.findUniqueOrThrow({ where: { sourceLeadId: w.leads.m2[0].id } });
      expect(acct.accountManagerId).toBe(w.U.m2.id);
      expect(acct.accountManagerId).not.toBe(w.U.adminA.id);
      expect(acct.teamId).toBe(w.teamA.id);
      // and m2 (the manager) sees it while m1 does not
      expect((await getAccount(testPrisma, w.S.m2, acct.id))?.id).toBe(acct.id);
      expect(await getAccount(testPrisma, w.S.m1, acct.id)).toBeNull();
    });

    it("the SUPER_ADMIN (no team) converting a lead: the account gets the lead's team, never null", async () => {
      const w = await world();
      expect(w.S.sa.teamId).toBeNull();
      const r = await moveLeadStage(testPrisma, w.S.sa, w.leads.m3[0].id, wonB(w).id);
      expect(r.autoConverted).toBe(true);
      const acct = await testPrisma.account.findUniqueOrThrow({ where: { sourceLeadId: w.leads.m3[0].id } });
      expect(acct.accountManagerId).toBe(w.U.m3.id);
      expect(acct.teamId).toBe(w.teamB.id);
      expect(acct.teamId).not.toBeNull();
    });

    it("the building stays with the team that WON it even if the owner has since changed teams", async () => {
      const w = await world();
      await testPrisma.user.update({ where: { id: w.U.m1.id }, data: { teamId: w.teamB.id } });
      await testPrisma.lead.update({ where: { id: w.leads.m1[0].id }, data: { stageId: won(w).id, wonAt: new Date() } });
      const { account } = await convertLeadToAccount(testPrisma, w.S.sa, w.leads.m1[0].id);
      expect(account.teamId).toBe(w.teamA.id);
      expect(account.accountManagerId).toBe(w.U.m1.id);
    });

    it("conversion is idempotent: a second convert returns the same account, created=false", async () => {
      const w = await world();
      await moveLeadStage(testPrisma, w.S.m1, w.leads.m1[0].id, won(w).id);
      const again = await convertLeadToAccount(testPrisma, w.S.m1, w.leads.m1[0].id);
      expect(again.created).toBe(false);
      expect(await testPrisma.account.count({ where: { sourceLeadId: w.leads.m1[0].id } })).toBe(1);
    });

    it("converting or moving a lead outside your scope is NotFound and creates nothing", async () => {
      const w = await world();
      expect(await outcome(() => moveLeadStage(testPrisma, w.S.m1, w.leads.m2[0].id, won(w).id))).toBe("NotFound");
      expect(await outcome(() => moveLeadStage(testPrisma, w.S.adminB, w.leads.m1[0].id, wonB(w).id))).toBe("NotFound");
      expect(await outcome(() => convertLeadToAccount(testPrisma, w.S.m1, w.leads.m2[0].id))).toBe("NotFound");
      expect(await outcome(() => convertLeadToAccount(testPrisma, w.S.adminB, w.leads.m1[0].id))).toBe("NotFound");
      expect(await testPrisma.account.count({ where: { sourceLeadId: { not: null } } })).toBe(0);
      expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: w.leads.m2[0].id } })).stageId).toBe(w.open.A.id);
    });
  });

  // ===========================================================================================
  // 6. wonInPeriod
  // ===========================================================================================
  describe("6. wonInPeriod counts the WIN, not the last edit", () => {
    const JAN = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-31T23:59:59Z") };

    it("editing an old won lead does NOT re-count it into the current period", async () => {
      const w = await world();
      const wonStage = stageOf(w.stages.A, "Won");
      const lead = w.leads.m1[0];
      await testPrisma.lead.update({ where: { id: lead.id }, data: { stageId: wonStage.id, wonAt: new Date("2026-01-15T00:00:00Z") } });
      const current = nowRange();

      expect((await getDashboardStats(testPrisma, w.S.m1, current)).sales.wonInPeriod).toBe(0);
      await updateLead(testPrisma, w.S.m1, lead.id, { title: "edited today", contactName: "someone new" });

      // Precondition that makes the old bug bite: the edit really did bump updatedAt into the window.
      const edited = await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(edited.updatedAt >= current.from && edited.updatedAt <= current.to).toBe(true);
      expect(edited.wonAt?.toISOString()).toBe("2026-01-15T00:00:00.000Z");

      expect((await getDashboardStats(testPrisma, w.S.m1, current)).sales.wonInPeriod).toBe(0);
      expect((await getDashboardStats(testPrisma, w.S.adminA, current)).sales.wonInPeriod).toBe(0);
      expect((await getDashboardStats(testPrisma, w.S.m1, JAN)).sales.wonInPeriod).toBe(1);
      expect((await getDashboardStats(testPrisma, w.S.adminA, JAN)).sales.wonInPeriod).toBe(1);
      // and it is counted for nobody outside the lead's scope
      expect((await getDashboardStats(testPrisma, w.S.m2, JAN)).sales.wonInPeriod).toBe(0);
      expect((await getDashboardStats(testPrisma, w.S.adminB, JAN)).sales.wonInPeriod).toBe(0);
    });

    it("moving INTO a won stage counts it now; moving out un-counts it; editing afterwards changes nothing", async () => {
      const w = await world();
      const lead = w.leads.m2[0];
      const current = nowRange();
      await moveLeadStage(testPrisma, w.S.m2, lead.id, stageOf(w.stages.A, "Won").id);
      const stamped = (await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).wonAt;
      expect(stamped).not.toBeNull();
      expect((await getDashboardStats(testPrisma, w.S.m2, current)).sales.wonInPeriod).toBe(1);

      await updateLead(testPrisma, w.S.m2, lead.id, { title: "edit after win" });
      expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).wonAt?.getTime()).toBe(stamped!.getTime());

      await moveLeadStage(testPrisma, w.S.m2, lead.id, w.open.A.id);
      expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).wonAt).toBeNull();
      expect((await getDashboardStats(testPrisma, w.S.m2, current)).sales.wonInPeriod).toBe(0);
    });

    it("WON -> WON (a team with two won stages) keeps the original win date", async () => {
      const w = await world();
      const scopeA = await resolveStageScope(testPrisma, w.S.adminA);
      const won2 = await createStage(testPrisma, scopeA, { name: "Won (signed)", type: "WON", probability: 100 });
      const lead = w.leads.m1[0];
      await moveLeadStage(testPrisma, w.S.m1, lead.id, stageOf(w.stages.A, "Won").id);
      const first = (await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).wonAt!;
      await moveLeadStage(testPrisma, w.S.m1, lead.id, won2.id);
      expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).wonAt?.getTime()).toBe(first.getTime());
    });

    it("a lead sitting in a won stage with no wonAt is not counted", async () => {
      const w = await world();
      await testPrisma.lead.update({ where: { id: w.leads.m1[0].id }, data: { stageId: stageOf(w.stages.A, "Won").id, wonAt: null } });
      expect((await getDashboardStats(testPrisma, w.S.m1, nowRange())).sales.wonInPeriod).toBe(0);
    });
  });

  // ===========================================================================================
  // 7. BUILDING CLAIMS
  // ===========================================================================================
  describe("7. building claims", () => {
    const newLead = (w: World, actorKey: ActorKey, name: string, team: "A" | "B" = "A") =>
      createLead(testPrisma, w.S[actorKey], {
        title: `t ${name}`, contactName: "c", stageId: w.open[team].id, companyName: name,
        ...(actorKey === "sa" ? { ownerId: w.U[team === "A" ? "m1" : "m3"].id } : {}),
      });

    it("a second member registering a held building gets 409 — same team and across teams", async () => {
      const w = await world();
      const sameTeam = await caught(() => newLead(w, "m2", "Bldg M1"));
      const crossTeam = await caught(() => newLead(w, "m3", "Bldg M1", "B"));
      const crossAdmin = await caught(() => newLead(w, "adminB", "Bldg M1", "B"));
      for (const e of [sameTeam, crossTeam, crossAdmin]) {
        expect(e).toBeInstanceOf(BuildingClaimedError);
        const res = errorResponse(e);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe("building_claimed");
      }
      expect(await testPrisma.lead.count({ where: { buildingKey: buildingKey("Bldg M1") } })).toBe(1);
    });

    it.each([
      "ismayil bey",
      "ISMAYIL BEY",
      "  İSMAYIL   bey  ",
      "İSMAYİL BEY",
      "ismayil\tbey",
      "ismayil bey",
    ])("case / whitespace / İ-i variant %j collides with 'İSMAYIL bey'", async (variant) => {
      const w = await world();
      await newLead(w, "m1", "İSMAYIL bey");
      expect(await outcome(() => newLead(w, "m2", variant)), "same-team lead").toBe("Claimed");
      expect(await outcome(() => newLead(w, "m3", variant, "B")), "cross-team lead").toBe("Claimed");
      expect(await outcome(() => createAccount(testPrisma, w.S.m3, { name: variant })), "cross-team account").toBe("Claimed");
      expect(await outcome(() => createAccount(testPrisma, w.S.m2, { name: variant })), "same-team account").toBe("Claimed");
      expect(await testPrisma.lead.count({ where: { buildingKey: buildingKey("İSMAYIL bey") } })).toBe(1);
      expect(await testPrisma.account.count({ where: { buildingKey: buildingKey("İSMAYIL bey") } })).toBe(0);
    });

    it("a building held by an ACCOUNT blocks new leads and accounts, org-wide", async () => {
      const w = await world();
      await createAccount(testPrisma, w.S.m1, { name: "Zafar Park" });
      expect(await outcome(() => newLead(w, "m2", "zafar  PARK"))).toBe("Claimed");
      expect(await outcome(() => newLead(w, "m3", "ZAFAR PARK", "B"))).toBe("Claimed");
      expect(await outcome(() => createAccount(testPrisma, w.S.m3, { name: " Zafar Park " }))).toBe("Claimed");
    });

    it("direct account create, account rename and lead rename all enforce the claim", async () => {
      const w = await world();
      // create
      expect(await outcome(() => createAccount(testPrisma, w.S.m2, { name: "BLDG m1" }))).toBe("Claimed");
      // account rename onto a lead-held building, and onto another account's
      expect(await outcome(() => updateAccount(testPrisma, w.S.m2, w.accounts.m2.id, { name: "bldg m1" }))).toBe("Claimed");
      expect(await outcome(() => updateAccount(testPrisma, w.S.m3, w.accounts.m3.id, { name: "ACCT M1" }))).toBe("Claimed");
      expect((await testPrisma.account.findUniqueOrThrow({ where: { id: w.accounts.m2.id } })).buildingKey).toBe(buildingKey("Acct m2"));
      // lead rename onto a lead-held and an account-held building
      expect(await outcome(() => updateLead(testPrisma, w.S.m2, w.leads.m2[0].id, { companyName: "BLDG M1" }))).toBe("Claimed");
      expect(await outcome(() => updateLead(testPrisma, w.S.m3, w.leads.m3[0].id, { companyName: "acct  m1" }))).toBe("Claimed");
      expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: w.leads.m2[0].id } })).buildingKey).toBe(buildingKey("Bldg M2"));

      // a harmless re-spelling of your OWN building is not a clash with yourself
      expect(await outcome(() => updateLead(testPrisma, w.S.m2, w.leads.m2[0].id, { companyName: "BLDG  M2" }))).toBe("ok");
      expect(await outcome(() => updateAccount(testPrisma, w.S.m2, w.accounts.m2.id, { name: "ACCT m2" }))).toBe("ok");
      // a real rename to a free name works, and FREES the old building for others
      expect(await outcome(() => updateLead(testPrisma, w.S.m2, w.leads.m2[0].id, { companyName: "Brand New Tower" }))).toBe("ok");
      expect(await outcome(() => newLead(w, "m3", "Bldg M2", "B"))).toBe("ok");
    });

    it("conversion while ANOTHER account holds the building: autoConverted=false, reason=building_claimed, lead still Won", async () => {
      const w = await world();
      const key = buildingKey("Contested Tower");
      // Raw rows: a lead and an account live in separate tables with separate unique indexes, so
      // this state is reachable (e.g. data predating the claim) and the guard must still hold.
      await testPrisma.account.create({ data: {
        companyId: w.companyId, teamId: w.teamB.id, accountManagerId: w.U.m3.id, name: "Contested Tower", buildingKey: key,
      } });
      const lead = await testPrisma.lead.create({ data: {
        companyId: w.companyId, teamId: w.teamA.id, ownerId: w.U.m1.id, stageId: w.open.A.id,
        title: "Contested", contactName: "c", companyName: "Contested Tower", buildingKey: key,
      } });
      const r = await moveLeadStage(testPrisma, w.S.m1, lead.id, stageOf(w.stages.A, "Won").id);
      expect(r.autoConverted).toBe(false);
      expect(r.reason).toBe("building_claimed");
      expect(r.lead.stageId).toBe(stageOf(w.stages.A, "Won").id);
      expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(0);
      // the explicit button is refused too, as a BuildingClaimedError (-> 409)
      const e = await caught(() => convertLeadToAccount(testPrisma, w.S.m1, lead.id));
      expect(e).toBeInstanceOf(BuildingClaimedError);
      expect(errorResponse(e).status).toBe(409);
    });

    it("a LOST lead keeps its claim", async () => {
      const w = await world();
      const lead = await newLead(w, "m1", "Lost Plaza");
      await moveLeadStage(testPrisma, w.S.m1, lead.id, stageOf(w.stages.A, "Lost").id, "no budget");
      expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stageId).toBe(stageOf(w.stages.A, "Lost").id);
      expect(await outcome(() => newLead(w, "m2", "lost plaza"))).toBe("Claimed");
      expect(await outcome(() => newLead(w, "m3", "LOST PLAZA", "B"))).toBe("Claimed");
      expect(await outcome(() => createAccount(testPrisma, w.S.m3, { name: "Lost Plaza" }))).toBe("Claimed");
    });

    it.each([0, 1, 2, 3, 4])("round %i: two concurrent createLead calls on one key -> exactly one succeeds", async (round) => {
      const w = await world();
      const name = `Race Tower ${round}`;
      const results = await Promise.allSettled([newLead(w, "m1", name), newLead(w, "m3", name.toUpperCase(), "B")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BuildingClaimedError);
      expect(await testPrisma.lead.count({ where: { buildingKey: buildingKey(name) } })).toBe(1);
    });

    it("a concurrent createLead and createAccount (different tables) on one key -> exactly one wins", async () => {
      const w = await world();
      for (let i = 0; i < 3; i++) {
        const name = `Cross Table Tower ${i}`;
        const results = await Promise.allSettled([
          newLead(w, "m1", name),
          createAccount(testPrisma, w.S.m3, { name }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled"), `iteration ${i}`).toHaveLength(1);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(rejected[0].reason).toBeInstanceOf(BuildingClaimedError);
        const leads = await testPrisma.lead.count({ where: { buildingKey: buildingKey(name) } });
        const accts = await testPrisma.account.count({ where: { buildingKey: buildingKey(name) } });
        expect(leads + accts, `iteration ${i}: total holders`).toBe(1);
      }
    });

    it("a MEMBER's refusal names the holder and their team and nothing from inside the record", async () => {
      const w = await world();
      const SECRETS = {
        title: "TOP-SECRET-TITLE", contactName: "Secret Contact Person", email: "secret@leak.test",
        phone: "+994-SECRET-PHONE", source: "SECRET-SOURCE",
      };
      const holder = await createLead(testPrisma, w.S.m1, {
        ...SECRETS, stageId: w.open.A.id, companyName: "Hidden Heights",
      });
      for (const who of ["m2", "m3"] as const) {
        const team = who === "m3" ? "B" : "A";
        const e = (await caught(() => newLead(w, who, "hidden heights", team))) as BuildingClaimedError;
        expect(e).toBeInstanceOf(BuildingClaimedError);
        expect(e.message).toBe(
          '"hidden heights" is already registered to Mina One (Team Alpha). Ask your team admin to reassign it.',
        );
        const wire = JSON.stringify(await errorResponse(e).json());
        for (const secret of [...Object.values(SECRETS), holder.id, "/crm", "http", holder.ownerId, w.teamA.id]) {
          expect(e.message, `${who}: message leaks ${secret}`).not.toContain(secret);
          expect(wire, `${who}: wire body leaks ${secret}`).not.toContain(secret);
        }
        expect(Object.keys(await errorResponse(e).json()).sort()).toEqual(["error", "message"]);
      }
      // account-held buildings expose the same, and only the same
      const acct = await createAccount(testPrisma, w.S.m1, { name: "Hidden Court", primaryContactName: "Acct Secret Person", primaryContactEmail: "acct-secret@leak.test" });
      const e2 = (await caught(() => newLead(w, "m3", "Hidden Court", "B"))) as BuildingClaimedError;
      for (const secret of ["Acct Secret Person", "acct-secret@leak.test", acct.id, "/accounts"]) {
        expect(e2.message).not.toContain(secret);
      }
      expect(e2.message).toContain("Mina One (Team Alpha)");
    });

    it("who gets the link: the holder, the holding team's admin and the SUPER_ADMIN — not the other team's admin", async () => {
      const w = await world();
      const holder = await newLead(w, "m1", "Linked Lofts");
      const msg = async (actor: ActorKey, team: "A" | "B") =>
        ((await caught(() => newLead(w, actor, "linked lofts", team))) as BuildingClaimedError).message;
      expect(await msg("m1", "A")).toBe(`You already have this building — /crm/${holder.id}`);
      expect(await msg("adminA", "A")).toContain(`/crm/${holder.id}`);
      expect(await msg("sa", "A")).toContain(`/crm/${holder.id}`);
      expect(await msg("adminB", "B")).not.toContain("/crm/");
      expect(await msg("m2", "A")).not.toContain("/crm/");
    });
  });

  // ===========================================================================================
  // 8. PER-TEAM STAGES AND FIELDS
  // ===========================================================================================
  describe("8. per-team stages and fields", () => {
    describe("stages", () => {
      it("a team admin cannot name another team, the org template, or anything but their own", async () => {
        const w = await world();
        expect(await outcome(() => resolveStageScope(testPrisma, w.S.adminA, { teamId: w.teamB.id }))).toBe("Forbidden");
        expect(await outcome(() => resolveStageScope(testPrisma, w.S.adminA, { teamId: null }))).toBe("Forbidden");
        expect(await outcome(() => resolveStageScope(testPrisma, w.S.m1, { teamId: w.teamB.id }))).toBe("Forbidden");
        expect(await outcome(() => resolveStageScope(testPrisma, w.S.sa))).toBe("Forbidden"); // SA must name a team
        expect(await resolveStageScope(testPrisma, w.S.adminA)).toEqual({ companyId: w.companyId, teamId: w.teamA.id });
        expect(await resolveStageScope(testPrisma, w.S.adminA, { teamId: w.teamA.id })).toEqual({ companyId: w.companyId, teamId: w.teamA.id });
      });

      it("by-id stage edits with your own scope cannot touch another team's stage", async () => {
        const w = await world();
        const scopeA = await resolveStageScope(testPrisma, w.S.adminA);
        const foreign = stageOf(w.stages.B, "Qualified");
        const before = await testPrisma.stage.findMany({ where: { teamId: w.teamB.id }, orderBy: { order: "asc" } });

        expect(await outcome(() => updateStage(testPrisma, scopeA, foreign.id, { name: "HACKED" }))).toBe("NotFound");
        expect(await outcome(() => deleteStage(testPrisma, scopeA, foreign.id))).toBe("NotFound");
        await reorderStages(testPrisma, scopeA, [...w.stages.B].reverse().map((s) => s.id));
        const after = await testPrisma.stage.findMany({ where: { teamId: w.teamB.id }, orderBy: { order: "asc" } });
        expect(after.map((s) => [s.id, s.name, s.order])).toEqual(before.map((s) => [s.id, s.name, s.order]));

        // and listing is per team
        expect(sortIds(await listStages(testPrisma, scopeA))).toEqual(sortIds(w.stages.A));
        // own-team edit works, and stays in team A
        await updateStage(testPrisma, scopeA, stageOf(w.stages.A, "Qualified").id, { name: "Qualified A" });
        expect((await testPrisma.stage.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe("Qualified");
      });

      it("a team's stage edits are invisible to the other team", async () => {
        const w = await world();
        const scopeA = await resolveStageScope(testPrisma, w.S.adminA);
        await createStage(testPrisma, scopeA, { name: "Only In Alpha", type: "OPEN" });
        const scopeB = await resolveStageScope(testPrisma, w.S.adminB);
        expect((await listStages(testPrisma, scopeB)).map((s) => s.name)).not.toContain("Only In Alpha");
      });

      it("a lead cannot reference another team's stage (create, move) or an org-template stage", async () => {
        const w = await world();
        const bStage = w.open.B;
        const template = await testPrisma.stage.create({ data: {
          companyId: w.companyId, teamId: null, name: "Template Open", type: "OPEN", order: 0,
        } });
        const mk = (actor: ActorKey, stageId: string, name: string) =>
          createLead(testPrisma, w.S[actor], { title: "t", contactName: "c", stageId, companyName: name });
        expect(await outcome(() => mk("m1", bStage.id, "Stage Probe 1"))).toBe("NotFound");
        expect(await outcome(() => mk("adminA", bStage.id, "Stage Probe 2"))).toBe("NotFound");
        expect(await outcome(() => mk("m1", template.id, "Stage Probe 3"))).toBe("NotFound");
        expect(await outcome(() => mk("m3", w.open.A.id, "Stage Probe 4"))).toBe("NotFound");
        expect(await outcome(() => moveLeadStage(testPrisma, w.S.m1, w.leads.m1[0].id, bStage.id))).toBe("NotFound");
        expect(await outcome(() => moveLeadStage(testPrisma, w.S.m1, w.leads.m1[0].id, template.id))).toBe("NotFound");
        expect(await outcome(() => moveLeadStage(testPrisma, w.S.sa, w.leads.m1[0].id, bStage.id))).toBe("NotFound");
        expect(await testPrisma.lead.count({ where: { title: "t" } })).toBe(0);
        expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: w.leads.m1[0].id } })).stageId).toBe(w.open.A.id);
      });
    });

    describe("account fields", () => {
      async function defs(w: World) {
        const a = [
          await createFieldDef(testPrisma, w.S.adminA, { label: "Total area", type: "NUMBER" }),
          await createFieldDef(testPrisma, w.S.adminA, { label: "Contract value", type: "CURRENCY" }),
        ];
        const b = [
          await createFieldDef(testPrisma, w.S.adminB, { label: "Total area", type: "NUMBER" }),
          await createFieldDef(testPrisma, w.S.adminB, { label: "Contract value", type: "DATE" }),
        ];
        return { a, b };
      }

      it("listing is per team; a team admin cannot edit, delete or reorder another team's definitions", async () => {
        const w = await world();
        const { a, b } = await defs(w);
        expect(sortIds(await listFieldDefs(testPrisma, w.S.adminA))).toEqual(sortIds(a));
        expect(sortIds(await listFieldDefs(testPrisma, w.S.adminB))).toEqual(sortIds(b));
        expect(sortIds(await listFieldDefs(testPrisma, w.S.m1))).toEqual(sortIds(a));
        expect(sortIds(await listFieldDefs(testPrisma, w.S.m3))).toEqual(sortIds(b));

        const before = await testPrisma.accountFieldDef.findMany({ where: { teamId: w.teamB.id }, orderBy: { order: "asc" } });
        expect(await outcome(() => updateFieldDef(testPrisma, w.S.adminA, b[0].id, { label: "HACKED" }))).toBe("NotFound");
        expect(await outcome(() => deleteFieldDef(testPrisma, w.S.adminA, b[0].id))).toBe("NotFound");
        await reorderFieldDefs(testPrisma, w.S.adminA, [b[1].id, b[0].id]);
        const after = await testPrisma.accountFieldDef.findMany({ where: { teamId: w.teamB.id }, orderBy: { order: "asc" } });
        expect(after.map((d) => [d.id, d.label, d.order])).toEqual(before.map((d) => [d.id, d.label, d.order]));
        // the SUPER_ADMIN's default scope is the TEMPLATE, so it cannot reach a live team's definition by id either
        expect(await outcome(() => updateFieldDef(testPrisma, w.S.sa, a[0].id, { label: "x" }))).toBe("NotFound");
      });

      it("scope resolution: other team / template / unnamed-SA are refused", async () => {
        const w = await world();
        expect(await outcome(() => resolveFieldDefScope(testPrisma, w.S.adminA, { teamId: w.teamB.id }))).toBe("Forbidden");
        expect(await outcome(() => resolveFieldDefScope(testPrisma, w.S.adminA, { teamId: null }))).toBe("Forbidden");
        expect(await outcome(() => resolveFieldDefScope(testPrisma, w.S.m1, { teamId: null }))).toBe("Forbidden");
        expect(await outcome(() => resolveFieldDefScope(testPrisma, w.S.sa))).toBe("Forbidden");
        expect(await resolveFieldDefScope(testPrisma, w.S.adminA)).toEqual({ companyId: w.companyId, teamId: w.teamA.id });
      });

      it("a value can only be set against a definition of the ACCOUNT's own team (not another team's, not the template)", async () => {
        const w = await world();
        const { a, b } = await defs(w);
        const template = await testPrisma.accountFieldDef.create({ data: {
          companyId: w.companyId, teamId: null, label: "Tpl", type: "TEXT", order: 0,
        } });
        expect(await outcome(() => setAccountFieldValue(testPrisma, w.S.m1, w.accounts.m1.id, b[0].id, "1"))).toBe("NotFound");
        expect(await outcome(() => setAccountFieldValue(testPrisma, w.S.m1, w.accounts.m1.id, template.id, "1"))).toBe("NotFound");
        expect(await outcome(() => setAccountFieldValue(testPrisma, w.S.m1, w.accounts.m2.id, a[0].id, "1"))).toBe("NotFound");
        expect(await outcome(() => setAccountFieldValue(testPrisma, w.S.m1, w.accounts.m3.id, b[0].id, "1"))).toBe("NotFound");
        expect(await testPrisma.accountFieldValue.count()).toBe(0);
        expect(await outcome(() => getAccountFields(testPrisma, w.S.m1, w.accounts.m2.id))).toBe("NotFound");
        expect(await outcome(() => setAccountFieldValue(testPrisma, w.S.m1, w.accounts.m1.id, a[0].id, "1200"))).toBe("ok");
        expect((await getAccountFields(testPrisma, w.S.adminA, w.accounts.m1.id)).map((r) => r.fieldDefId)).toEqual(a.map((d) => d.id));
      });
    });

    describe("template", () => {
      const snap = async (teamId: string) => {
        const [stages, defs] = await Promise.all([
          testPrisma.stage.findMany({ where: { teamId }, orderBy: { order: "asc" } }),
          testPrisma.accountFieldDef.findMany({ where: { teamId }, orderBy: { order: "asc" } }),
        ]);
        return {
          stages: stages.map((s) => ({ id: s.id, name: s.name, type: s.type, order: s.order, probability: s.probability })),
          defs: defs.map((d) => ({ id: d.id, label: d.label, type: d.type, order: d.order })),
        };
      };

      it("a new team receives the org template; later template edits do NOT change existing teams", async () => {
        const w = await world();
        const create = (name: string) => createTeamWithAdmin(testPrisma, w.S.sa, {
          name, adminName: `${name} admin`, adminEmail: `${uniq("adm-")}@t.local`, adminPassword: "password123",
        });

        const c = await create("Team Charlie");
        const snapC = await snap(c.team.id);
        expect(snapC.stages.map((s) => [s.name, s.type, s.probability])).toEqual(DEFAULT_STAGES.map((s) => [s.name, s.type, s.probability]));
        expect(snapC.defs.map((d) => [d.label, d.type])).toEqual(TEMPLATE_FIELD_DEFS.map((d) => [d.label, d.type]));
        // clones, not references
        const template = await testPrisma.stage.findMany({ where: { companyId: w.companyId, teamId: null } });
        expect(template.length).toBeGreaterThan(0);
        for (const s of snapC.stages) expect(template.map((t) => t.id)).not.toContain(s.id);

        const snapA = await snap(w.teamA.id);
        const snapB = await snap(w.teamB.id);

        // Edit the TEMPLATE as the SUPER_ADMIN: rename, add a stage, rename and add a field.
        const tplScope = await resolveStageScope(testPrisma, w.S.sa, { teamId: null });
        const tplWon = template.find((s) => s.name === "Won")!;
        await updateStage(testPrisma, tplScope, tplWon.id, { name: "Closed Won" });
        await createStage(testPrisma, tplScope, { name: "Site Visit", type: "OPEN" });
        const tplDefs = await listFieldDefs(testPrisma, w.S.sa);
        await updateFieldDef(testPrisma, w.S.sa, tplDefs.find((d) => d.label === "Total area")!.id, { label: "Total area m2" });
        await createFieldDef(testPrisma, w.S.sa, { label: "Floors", type: "NUMBER" });

        // existing teams: byte-for-byte unchanged (same ids, names, order)
        expect(await snap(w.teamA.id)).toEqual(snapA);
        expect(await snap(w.teamB.id)).toEqual(snapB);
        expect(await snap(c.team.id)).toEqual(snapC);

        // a team created AFTER the edit gets the new template
        const d = await create("Team Delta");
        const snapD = await snap(d.team.id);
        expect(snapD.stages.map((s) => s.name)).toContain("Closed Won");
        expect(snapD.stages.map((s) => s.name)).toContain("Site Visit");
        expect(snapD.defs.map((x) => x.label)).toEqual(expect.arrayContaining(["Total area m2", "Floors"]));
      });

      it("only the SUPER_ADMIN may create teams; a team admin cannot edit the template", async () => {
        const w = await world();
        const args = { name: "Rogue", adminName: "x", adminEmail: `${uniq("adm-")}@t.local`, adminPassword: "password123" };
        expect(await outcome(() => createTeamWithAdmin(testPrisma, w.S.adminA, args))).toBe("Forbidden");
        expect(await outcome(() => createTeamWithAdmin(testPrisma, w.S.m1, args))).toBe("Forbidden");
        expect(await testPrisma.team.count({ where: { name: "Rogue" } })).toBe(0);
      });
    });
  });

  // ===========================================================================================
  // 9. CROSS-TEAM TRANSFER
  // ===========================================================================================
  describe("9. cross-team transfer", () => {
    it("lead: stage remapped by name, then by type; WON stays WON (wonAt and win counts do not shift)", async () => {
      const w = await world();
      // Make team B's pipeline differ from A's: a renamed stage, a renamed WON stage, and an OPEN
      // stage that is NAMED "Won" — the trap a name-only match would fall into.
      const scopeB = await resolveStageScope(testPrisma, w.S.adminB);
      await updateStage(testPrisma, scopeB, stageOf(w.stages.B, "Proposal").id, { name: "Offer" });
      await updateStage(testPrisma, scopeB, stageOf(w.stages.B, "Won").id, { name: "Closed Deal" });
      const trap = await createStage(testPrisma, scopeB, { name: "Won", type: "OPEN" });
      const B = await listStages(testPrisma, scopeB);

      const WON_AT = new Date("2026-02-02T00:00:00Z");
      const place = async (lead: Lead, stageName: string, extra: { wonAt?: Date } = {}) =>
        testPrisma.lead.update({ where: { id: lead.id }, data: { stageId: stageOf(w.stages.A, stageName).id, ...extra } });
      // m1 owns one lead; borrow extra leads from the same team via raw creates for the other cases.
      const extra = async (name: string) => testPrisma.lead.create({ data: {
        companyId: w.companyId, teamId: w.teamA.id, ownerId: w.U.m1.id, stageId: w.open.A.id,
        title: name, contactName: "c", companyName: name, buildingKey: buildingKey(name),
      } });
      const byName = await extra("Xfer By Name");
      const byType = await extra("Xfer By Type");
      const wonLead = await extra("Xfer Won");
      const lostLead = await extra("Xfer Lost");
      await place(byName, "Qualified");
      await place(byType, "Proposal");
      await place(wonLead, "Won", { wonAt: WON_AT });
      await place(lostLead, "Lost");

      const range = { from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-02-28T23:59:59Z") };
      const wonBefore = {
        A: (await getDashboardStats(testPrisma, w.S.adminA, range)).sales.wonInPeriod,
        B: (await getDashboardStats(testPrisma, w.S.adminB, range)).sales.wonInPeriod,
      };
      expect(wonBefore).toEqual({ A: 1, B: 0 });

      const moved: Record<string, Lead> = {};
      for (const l of [byName, byType, wonLead, lostLead]) {
        moved[l.title] = await updateLead(testPrisma, w.S.sa, l.id, { ownerId: w.U.m3.id });
      }

      for (const l of Object.values(moved)) {
        expect(l.ownerId).toBe(w.U.m3.id);
        expect(l.teamId).toBe(w.teamB.id);
      }
      expect(moved["Xfer By Name"].stageId).toBe(stageOf(B, "Qualified").id); // same name
      expect(moved["Xfer By Type"].stageId).toBe(stageOf(B, "New").id); // "Proposal" is "Offer" in B -> first OPEN
      expect(moved["Xfer Won"].stageId).toBe(stageOf(B, "Closed Deal").id); // WON -> WON
      expect(moved["Xfer Won"].stageId).not.toBe(trap.id); // NOT the OPEN stage named "Won"
      expect(moved["Xfer Lost"].stageId).toBe(stageOf(B, "Lost").id);
      // every landed stage is of the same TYPE and belongs to team B
      const landed = await testPrisma.stage.findMany({ where: { id: { in: Object.values(moved).map((l) => l.stageId) } } });
      expect(landed.every((s) => s.teamId === w.teamB.id)).toBe(true);
      expect(landed.find((s) => s.id === moved["Xfer Won"].stageId)!.type).toBe("WON");
      expect(landed.find((s) => s.id === moved["Xfer By Type"].stageId)!.type).toBe("OPEN");

      // wonAt untouched, so the win moved teams without changing the numbers
      expect(moved["Xfer Won"].wonAt?.toISOString()).toBe(WON_AT.toISOString());
      const wonAfter = {
        A: (await getDashboardStats(testPrisma, w.S.adminA, range)).sales.wonInPeriod,
        B: (await getDashboardStats(testPrisma, w.S.adminB, range)).sales.wonInPeriod,
      };
      expect(wonAfter).toEqual({ A: 0, B: 1 });
      expect(wonAfter.A + wonAfter.B).toBe(wonBefore.A + wonBefore.B);

      // the history records it
      const acts = await testPrisma.activity.findMany({ where: { leadId: wonLead.id, kind: "STAGE_CHANGE" } });
      expect(acts.some((a) => a.body.includes("Transferred to Team Bravo"))).toBe(true);

      // visibility followed the transfer
      expect(await getLead(testPrisma, w.S.m1, wonLead.id)).toBeNull();
      expect(await getLead(testPrisma, w.S.adminA, wonLead.id)).toBeNull();
      expect((await getLead(testPrisma, w.S.m3, wonLead.id))?.id).toBe(wonLead.id);
      expect((await getLead(testPrisma, w.S.adminB, wonLead.id))?.id).toBe(wonLead.id);
    });

    it("lead: open tasks assigned to someone who can no longer see it are unassigned; done tasks keep history", async () => {
      const w = await world();
      const lead = w.leads.m1[0];
      const open = await testPrisma.task.create({ data: { companyId: w.companyId, leadId: lead.id, title: "o", assigneeId: w.U.m1.id } });
      const done = await testPrisma.task.create({ data: { companyId: w.companyId, leadId: lead.id, title: "d", assigneeId: w.U.m1.id, done: true } });
      await updateLead(testPrisma, w.S.sa, lead.id, { ownerId: w.U.m3.id });
      expect((await testPrisma.task.findUniqueOrThrow({ where: { id: open.id } })).assigneeId).toBeNull();
      expect((await testPrisma.task.findUniqueOrThrow({ where: { id: done.id } })).assigneeId).toBe(w.U.m1.id);
      // the team-A admin task is also unseeable by the new team's people
      expect((await testPrisma.task.findUniqueOrThrow({ where: { id: w.adminTask.id } })).assigneeId).toBeNull();
    });

    it("only the SUPER_ADMIN can transfer across teams; nobody else can even attempt it", async () => {
      const w = await world();
      const lead = w.leads.m1[0];
      expect(await outcome(() => updateLead(testPrisma, w.S.adminA, lead.id, { ownerId: w.U.m3.id }))).toBe("Forbidden");
      expect(await outcome(() => updateLead(testPrisma, w.S.adminB, lead.id, { ownerId: w.U.m3.id }))).toBe("NotFound");
      expect(await outcome(() => updateLead(testPrisma, w.S.m1, lead.id, { ownerId: w.U.m3.id }))).toBe("Forbidden");
      const row = await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(row.teamId).toBe(w.teamA.id);
      expect(row.ownerId).toBe(w.U.m1.id);
      expect(row.stageId).toBe(w.open.A.id);
    });

    it("a same-team reassignment changes the owner only: team, stage and history are untouched", async () => {
      const w = await world();
      const lead = w.leads.m1[0];
      const r = await updateLead(testPrisma, w.S.adminA, lead.id, { ownerId: w.U.m2.id });
      expect(r.ownerId).toBe(w.U.m2.id);
      expect(r.teamId).toBe(w.teamA.id);
      expect(r.stageId).toBe(lead.stageId);
      expect(await testPrisma.activity.count({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } })).toBe(0);
    });

    it("account: field values remap to the target team's definitions; unmatched ones are preserved in a NOTE", async () => {
      const w = await world();
      const mkDef = (actor: ActorKey, label: string, type: "TEXT" | "NUMBER" | "CURRENCY" | "DATE") =>
        createFieldDef(testPrisma, w.S[actor], { label, type });
      const a = {
        area: await mkDef("adminA", "Total area", "NUMBER"),
        value: await mkDef("adminA", "Contract value", "CURRENCY"),
        plan: await mkDef("adminA", "Floor plan", "TEXT"),
      };
      const b = {
        area: await mkDef("adminB", "Total area", "NUMBER"),
        valueAsDate: await mkDef("adminB", "Contract value", "DATE"), // same label, DIFFERENT type
      };
      const acct = w.accounts.m1;
      await setAccountFieldValue(testPrisma, w.S.m1, acct.id, a.area.id, "1200");
      await setAccountFieldValue(testPrisma, w.S.m1, acct.id, a.value.id, "5000");
      await setAccountFieldValue(testPrisma, w.S.m1, acct.id, a.plan.id, "See PDF");

      // not by a team admin or the manager
      expect(await outcome(() => updateAccount(testPrisma, w.S.adminA, acct.id, { accountManagerId: w.U.m3.id }))).toBe("Forbidden");
      expect(await outcome(() => updateAccount(testPrisma, w.S.m1, acct.id, { accountManagerId: w.U.m3.id }))).toBe("Forbidden");
      expect(await testPrisma.accountFieldValue.count({ where: { accountId: acct.id } })).toBe(3);

      const moved = await updateAccount(testPrisma, w.S.sa, acct.id, { accountManagerId: w.U.m3.id });
      expect(moved.teamId).toBe(w.teamB.id);
      expect(moved.accountManagerId).toBe(w.U.m3.id);

      // matched label+type: re-pointed at B's definition, value intact
      const values = await testPrisma.accountFieldValue.findMany({ where: { accountId: acct.id } });
      expect(values.map((v) => [v.fieldDefId, v.value])).toEqual([[b.area.id, "1200"]]);
      const rows = await getAccountFields(testPrisma, w.S.m3, acct.id);
      expect(rows.map((r) => [r.label, r.value])).toEqual([["Total area", "1200"], ["Contract value", ""]]);

      // unmatched (type mismatch, and no counterpart): preserved in ONE note, then removed from the defs
      const notes = await testPrisma.accountActivity.findMany({ where: { accountId: acct.id, kind: "NOTE" } });
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toContain("Fields from previous team");
      expect(notes[0].body).toContain("Contract value: 5000");
      expect(notes[0].body).toContain("Floor plan: See PDF");
      expect(notes[0].body).not.toContain("Total area");
      expect(await testPrisma.accountFieldValue.count({ where: { fieldDefId: { in: [a.area.id, a.value.id, a.plan.id] } } })).toBe(0);

      // visibility followed the transfer
      expect(await getAccount(testPrisma, w.S.m1, acct.id)).toBeNull();
      expect(await getAccount(testPrisma, w.S.adminA, acct.id)).toBeNull();
      expect((await getAccount(testPrisma, w.S.m3, acct.id))?.id).toBe(acct.id);
      expect((await getAccount(testPrisma, w.S.adminB, acct.id))?.id).toBe(acct.id);
    });
  });
});
