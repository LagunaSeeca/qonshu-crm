import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeTeamWithUsers, makeUser, su, uniq, buildingKey } from "@/test/fixtures";
import {
  createAccount, createAccountWithLogin, listAccounts, getAccount, updateAccount,
  createPartnerLogin, listPartnerLogins,
  isPartnerKeyConflict, PartnerLoginExistsError,
} from "./accounts";
import { createFieldDef, setAccountFieldValue, getAccountFields } from "./account-fields";
import { BuildingClaimedError } from "./building-claim";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { verifyPassword } from "@/lib/auth/password";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// The CREATE path no longer calls the upstream at all — a newly named building stakes a PENDING
// link derived from its own name (see the pending-link describe below). `fetchPartners` is still
// mocked here, and still defaults to an EMPTY list, so that any test which accidentally reaches
// for the upstream fails loudly instead of hitting the network.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));
import { fetchPartners } from "@/lib/partner-api/client";

function partners(...names: string[]): PartnerListResponse {
  return { partners: names.map((name) => ({ name, type: "RESIDENTIAL" as const })) };
}

let savedApiKey: string | undefined;

async function prepare() {
  await resetDb();
  savedApiKey = process.env.PARTNER_API_KEY;
  process.env.PARTNER_API_KEY = "sk_test_shared";
  vi.mocked(fetchPartners).mockReset();
  vi.mocked(fetchPartners).mockResolvedValue(partners());
}

function restore() {
  if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
  else process.env.PARTNER_API_KEY = savedApiKey;
}

describe("accounts: scope and ownership", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  it("a MEMBER's new account is owned by them, on their team, in their team's company", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: uniq("Building ") });
    expect(acc.accountManagerId).toBe(t.member.id);
    expect(acc.teamId).toBe(t.team.id);
    expect(acc.companyId).toBe(t.companyId);
  });

  // THE HOLE THIS CLOSES: accountManagerId used to be written straight through with no check at
  // all — any id, from any company, including a role that must never appear in a sales book.
  it("refuses an accountManagerId that is not assignable, instead of writing it through", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeamWithUsers({ companyId: a.companyId });
    const partner = await makeUser("PARTNER_VIEWER", a.team);
    const sa = await makeUser("SUPER_ADMIN");

    // A sibling team's member: a team admin cannot park work in another team's book.
    await expect(
      createAccount(testPrisma, a.suAdmin, { name: uniq("X "), accountManagerId: b.member.id }),
    ).rejects.toThrow(ForbiddenError);
    // A partner login and a super admin are not ownable at all.
    await expect(
      createAccount(testPrisma, a.suAdmin, { name: uniq("X "), accountManagerId: partner.id }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      createAccount(testPrisma, su(sa), { name: uniq("X "), accountManagerId: sa.id }),
    ).rejects.toThrow(ForbiddenError);
    // An id that is not a user at all.
    await expect(
      createAccount(testPrisma, a.suAdmin, { name: uniq("X "), accountManagerId: "no-such-user" }),
    ).rejects.toThrow(ForbiddenError);
    expect(await testPrisma.account.count()).toBe(0);
  });

  it("a MEMBER's supplied accountManagerId is IGNORED, not an error", async () => {
    const t = await makeTeamWithUsers();
    const peer = await makeUser("MEMBER", t.team);
    // Every create form posts the field; a member tampering with it must simply have no effect,
    // not get an error they can probe other ids with.
    const acc = await createAccount(testPrisma, t.suMember, { name: uniq("B "), accountManagerId: peer.id });
    expect(acc.accountManagerId).toBe(t.member.id);
  });

  it("a MEMBER sees only their own accounts; a team admin sees the team; a sibling team sees none", async () => {
    const a = await makeTeamWithUsers();
    const peer = await makeUser("MEMBER", a.team);
    const b = await makeTeamWithUsers({ companyId: a.companyId });

    const mine = await createAccount(testPrisma, a.suMember, { name: uniq("Mine ") });
    const theirs = await createAccount(testPrisma, su(peer), { name: uniq("Theirs ") });
    await createAccount(testPrisma, b.suMember, { name: uniq("Other team ") });

    expect((await listAccounts(testPrisma, a.suMember)).map((x) => x.id)).toEqual([mine.id]);
    expect((await listAccounts(testPrisma, a.suAdmin)).map((x) => x.id).sort())
      .toEqual([mine.id, theirs.id].sort());
    expect((await listAccounts(testPrisma, b.suAdmin)).map((x) => x.id)).toHaveLength(1);

    // getAccount is the chokepoint every child write goes through.
    expect(await getAccount(testPrisma, a.suMember, theirs.id)).toBeNull();
    expect(await getAccount(testPrisma, b.suAdmin, mine.id)).toBeNull();
    expect(await getAccount(testPrisma, a.suAdmin, theirs.id)).not.toBeNull();
  });

  it("a PARTNER_VIEWER sees exactly its own account, and nothing when it has none", async () => {
    const t = await makeTeamWithUsers();
    const mine = await createAccount(testPrisma, t.suMember, { name: uniq("P ") });
    const other = await createAccount(testPrisma, t.suMember, { name: uniq("Q ") });
    const partner = await makeUser("PARTNER_VIEWER", t.team, { accountId: mine.id });
    const orphan = await makeUser("PARTNER_VIEWER", t.team);

    expect((await listAccounts(testPrisma, su(partner))).map((x) => x.id)).toEqual([mine.id]);
    expect(await getAccount(testPrisma, su(partner), other.id)).toBeNull();
    expect(await listAccounts(testPrisma, su(orphan))).toEqual([]);
    expect(await getAccount(testPrisma, su(orphan), mine.id)).toBeNull();
  });

  // A SUPER_ADMIN has companyId null, which accountScopeWhere rejects outright. getAccount gives
  // it the one thing scope.ts asks for — a concrete company context — taken from the account the
  // request already names.
  it("a SUPER_ADMIN can resolve any one account by id", async () => {
    const a = await makeTeamWithUsers();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const acc = await createAccount(testPrisma, a.suMember, { name: uniq("SA ") });
    expect((await getAccount(testPrisma, sa, acc.id))?.id).toBe(acc.id);
    expect(await getAccount(testPrisma, sa, "no-such-account")).toBeNull();
  });
});

describe("accounts: one building, one record", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  it("stores the normalized building key and refuses a second record for the same building", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeamWithUsers({ companyId: a.companyId });

    const first = await createAccount(testPrisma, a.suMember, { name: "Sabah  CITY " });
    expect(first.buildingKey).toBe(buildingKey("Sabah City"));

    // A DIFFERENT team, a different spelling, same building — refused with the 409 the claim
    // guard builds, not a bare unique-index violation.
    await expect(
      createAccount(testPrisma, b.suMember, { name: "sabah city" }),
    ).rejects.toThrow(BuildingClaimedError);
    expect(await testPrisma.account.count()).toBe(1);
  });

  it("refuses an account for a building an OPEN LEAD already holds — separate tables, one claim", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeamWithUsers({ companyId: a.companyId });
    await testPrisma.lead.create({ data: {
      companyId: a.companyId, teamId: a.team.id, buildingKey: buildingKey("Park Villa"),
      title: "Park Villa deal", contactName: "C", companyName: "Park Villa",
      ownerId: a.member.id,
      stageId: (await testPrisma.stage.create({ data: {
        companyId: a.companyId, teamId: a.team.id, name: "New", order: 0, type: "OPEN",
      } })).id,
    } });

    await expect(
      createAccount(testPrisma, b.suMember, { name: "Park Villa" }),
    ).rejects.toThrow(BuildingClaimedError);
  });

  it("a RENAME is a re-claim: refused onto a taken building, allowed onto a free one", async () => {
    const t = await makeTeamWithUsers();
    const held = await createAccount(testPrisma, t.suMember, { name: "Held Tower" });
    const mine = await createAccount(testPrisma, t.suMember, { name: "My Tower" });

    await expect(
      updateAccount(testPrisma, t.suMember, mine.id, { name: "held  TOWER" }),
    ).rejects.toThrow(BuildingClaimedError);

    const renamed = await updateAccount(testPrisma, t.suMember, mine.id, { name: "New Tower" });
    expect(renamed.buildingKey).toBe(buildingKey("New Tower"));
    // Re-saving its OWN name is not a clash.
    await expect(updateAccount(testPrisma, t.suMember, renamed.id, { name: "New Tower" })).resolves.toBeTruthy();
    expect((await getAccount(testPrisma, t.suMember, held.id))?.name).toBe("Held Tower");
  });
});

describe("accounts: reassignment and cross-team transfer", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  it("a same-team manager change clears stale open assignees, keeps done tasks and valid assignees", async () => {
    const t = await makeTeamWithUsers();
    const oldMgr = t.member;
    const newMgr = await makeUser("MEMBER", t.team);
    const acc = await createAccount(testPrisma, t.suAdmin, { name: uniq("S "), accountManagerId: oldMgr.id });
    const mk = (title: string, assigneeId: string | null, done = false) =>
      testPrisma.accountTask.create({ data: { companyId: acc.companyId, accountId: acc.id, title, assigneeId, done } });
    const stale = await mk("stale", oldMgr.id);
    const doneOld = await mk("done", oldMgr.id, true);
    const forNew = await mk("new", newMgr.id);
    const forAdmin = await mk("admin", t.admin.id);
    const unassigned = await mk("none", null);

    await updateAccount(testPrisma, t.suAdmin, acc.id, { accountManagerId: newMgr.id });

    const get = async (id: string) => (await testPrisma.accountTask.findUniqueOrThrow({ where: { id } })).assigneeId;
    expect(await get(stale.id)).toBeNull();
    expect(await get(doneOld.id)).toBe(oldMgr.id);
    expect(await get(forNew.id)).toBe(newMgr.id);
    expect(await get(forAdmin.id)).toBe(t.admin.id);
    expect(await get(unassigned.id)).toBeNull();
  });

  it("listAccounts filters (status, manager, q) can only narrow a member's scope", async () => {
    const t = await makeTeamWithUsers();
    const mate = await makeUser("MEMBER", t.team);
    const mine = await createAccount(testPrisma, t.suMember, { name: "Shared Tower" });
    const theirs = await createAccount(testPrisma, su(mate), { name: "Shared Plaza" });
    const ids = async (o: Parameters<typeof listAccounts>[2]) => (await listAccounts(testPrisma, t.suMember, o)).map((a) => a.id);
    expect(await ids({ q: "Shared" })).toEqual([mine.id]);
    expect(await ids({ accountManagerId: mate.id })).toEqual([]);
    expect(await ids({ accountManagerId: mate.id, q: "Plaza", status: theirs.status })).toEqual([]);
    expect(await ids({ accountManagerId: t.member.id, q: "Tower", status: mine.status })).toEqual([mine.id]);
  });

  it("a MEMBER cannot hand their account to anyone else", async () => {
    const t = await makeTeamWithUsers();
    const peer = await makeUser("MEMBER", t.team);
    const acc = await createAccount(testPrisma, t.suMember, { name: uniq("R ") });
    await expect(
      updateAccount(testPrisma, t.suMember, acc.id, { accountManagerId: peer.id }),
    ).rejects.toThrow(ForbiddenError);
    // Re-posting the CURRENT manager is not a reassignment — the edit form always sends it.
    await expect(
      updateAccount(testPrisma, t.suMember, acc.id, { accountManagerId: t.member.id, industry: "x" }),
    ).resolves.toMatchObject({ industry: "x" });
  });

  it("a team admin reassigns within their own team and nowhere else", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeamWithUsers({ companyId: a.companyId });
    const peer = await makeUser("MEMBER", a.team);
    const acc = await createAccount(testPrisma, a.suMember, { name: uniq("R ") });

    const moved = await updateAccount(testPrisma, a.suAdmin, acc.id, { accountManagerId: peer.id });
    expect(moved.accountManagerId).toBe(peer.id);
    expect(moved.teamId).toBe(a.team.id);

    await expect(
      updateAccount(testPrisma, a.suAdmin, acc.id, { accountManagerId: b.member.id }),
    ).rejects.toThrow(ForbiddenError);
  });

  // The whole point of requirement 10: the values follow the account, the lead does not.
  it("a SUPER_ADMIN transfer moves the team, remaps matching field values and notes the rest", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeamWithUsers({ companyId: a.companyId });
    const sa = su(await makeUser("SUPER_ADMIN"));

    // Both teams define "Total area" as a NUMBER; only A defines "Lift count", and B's
    // "Doorman" is a DATE where A's is TEXT — so only the first label+type pair can be carried.
    const areaA = await createFieldDef(testPrisma, a.suAdmin, { label: "Total area", type: "NUMBER" });
    const liftA = await createFieldDef(testPrisma, a.suAdmin, { label: "Lift count", type: "NUMBER" });
    const doorA = await createFieldDef(testPrisma, a.suAdmin, { label: "Doorman", type: "TEXT" });
    const areaB = await createFieldDef(testPrisma, b.suAdmin, { label: "Total area", type: "NUMBER" });
    await createFieldDef(testPrisma, b.suAdmin, { label: "Doorman", type: "DATE" });

    const acc = await createAccount(testPrisma, a.suMember, { name: uniq("Transfer ") });
    await setAccountFieldValue(testPrisma, a.suMember, acc.id, areaA.id, "1200");
    await setAccountFieldValue(testPrisma, a.suMember, acc.id, liftA.id, "3");
    await setAccountFieldValue(testPrisma, a.suMember, acc.id, doorA.id, "Ali");

    const moved = await updateAccount(testPrisma, sa, acc.id, { accountManagerId: b.member.id });

    expect(moved.teamId).toBe(b.team.id);
    expect(moved.accountManagerId).toBe(b.member.id);

    // The matching definition kept its value, now pointing at B's own field.
    const rows = await getAccountFields(testPrisma, b.suMember, acc.id);
    expect(rows.find((r) => r.fieldDefId === areaB.id)?.value).toBe("1200");
    // Nothing is left pointing at A's definitions.
    expect(await testPrisma.accountFieldValue.count({
      where: { accountId: acc.id, fieldDefId: { in: [areaA.id, liftA.id, doorA.id] } },
    })).toBe(0);
    // The two that could not be carried survive as ONE human-readable note, not as silent loss.
    const notes = await testPrisma.accountActivity.findMany({ where: { accountId: acc.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("Fields from previous team");
    expect(notes[0].body).toContain("Lift count: 3");
    expect(notes[0].body).toContain("Doorman: Ali");
    expect(notes[0].body).not.toContain("Total area");
  });

  it("the SOURCE LEAD stays with the team that won it", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeamWithUsers({ companyId: a.companyId });
    const sa = su(await makeUser("SUPER_ADMIN"));
    const stage = await testPrisma.stage.create({ data: {
      companyId: a.companyId, teamId: a.team.id, name: "Won", order: 0, type: "WON",
    } });
    const lead = await testPrisma.lead.create({ data: {
      companyId: a.companyId, teamId: a.team.id, buildingKey: buildingKey("Keep Tower"),
      title: "Keep Tower", contactName: "C", companyName: "Keep Tower",
      ownerId: a.member.id, stageId: stage.id,
    } });
    const acc = await createAccount(testPrisma, a.suMember, { name: "Keep Tower", sourceLeadId: lead.id });

    await updateAccount(testPrisma, sa, acc.id, { accountManagerId: b.member.id });

    const after = await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.teamId).toBe(a.team.id);
    expect(after.ownerId).toBe(a.member.id);
  });
});

describe("accounts: partner logins", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  it("createAccountWithLogin provisions a PARTNER_VIEWER with no team and the account set", async () => {
    const t = await makeTeamWithUsers();
    const email = `${uniq("pl-")}@test.local`;
    // The team ADMIN is the caller throughout this describe: minting a PARTNER_VIEWER is
    // admin-only (see the privilege-escalation cases below). A member's call never gets far
    // enough to exercise any of the behaviour these tests are about.
    const { account, partnerUser } = await createAccountWithLogin(testPrisma, t.suAdmin, {
      name: uniq("Duo "),
      partnerLogin: { name: "Partner Contact", email, password: "pw123456" },
    });
    expect(partnerUser!.role).toBe("PARTNER_VIEWER");
    expect(partnerUser!.accountId).toBe(account.id);
    expect(partnerUser!.teamId).toBeNull();
    expect(partnerUser!.companyId).toBe(t.companyId);
    expect(await verifyPassword("pw123456", partnerUser!.passwordHash)).toBe(true);
  });

  it("without partnerLogin creates just the account", async () => {
    const t = await makeTeamWithUsers();
    const { account, partnerUser } = await createAccountWithLogin(testPrisma, t.suMember, { name: uniq("Solo ") });
    expect(partnerUser).toBeNull();
    expect(await testPrisma.user.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("rolls the whole unit back when the partner email is already taken", async () => {
    const t = await makeTeamWithUsers();
    const email = `${uniq("dup-")}@test.local`;
    await createAccountWithLogin(testPrisma, t.suAdmin, {
      name: uniq("First "), partnerLogin: { name: "P1", email, password: "pw123456" },
    });
    const secondName = uniq("Second ");
    await expect(createAccountWithLogin(testPrisma, t.suAdmin, {
      name: secondName, partnerLogin: { name: "P2", email, password: "pw123456" },
    })).rejects.toThrow();
    expect(await testPrisma.account.count({ where: { name: secondName } })).toBe(0);
  });

  // PRIVILEGE ESCALATION, CLOSED. The premise this test used to assert — "the sales manager owns
  // the relationship with their representative, so they create the login themselves" — WAS the
  // vulnerability. A PARTNER_VIEWER holds exactly the capabilities a MEMBER is denied
  // (view_settlements, view_payment_detail, view_object_detail), so a member who may mint one on
  // an account they legitimately manage can set its password, log in as it, and read the
  // settlement and payment data their own role refuses. Scope cannot catch that: the account
  // really is theirs. Only a team admin may mint.
  it("a MEMBER cannot create its account's login, an admin can", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: uniq("Own ") });

    // The account's OWN manager — in scope, and still refused.
    await expect(createPartnerLogin(testPrisma, t.suMember, acc.id, {
      name: "Rep", email: `${uniq("rep-")}@test.local`, password: "pw123456",
    })).rejects.toThrow(ForbiddenError);
    // ...and the refusal is complete: no partner User row was written before the throw.
    expect(await testPrisma.user.count({ where: { accountId: acc.id } })).toBe(0);

    // The team admin may, so the capability moved rather than disappeared.
    const login = await createPartnerLogin(testPrisma, t.suAdmin, acc.id, {
      name: "Rep", email: `${uniq("rep-")}@test.local`, password: "pw123456",
    });
    const row = await testPrisma.user.findUniqueOrThrow({ where: { id: login.id } });
    expect(row.role).toBe("PARTNER_VIEWER");
    expect(row.teamId).toBeNull();
    expect(row.accountId).toBe(acc.id);
    // Masked: the returned shape carries no passwordHash at all.
    expect(Object.keys(login).sort()).toEqual(["email", "id", "name", "status"]);
  });

  // An out-of-scope id is refused by getAccount, which runs FIRST — so the answer a non-admin
  // gets is the same NotFound a non-existent id gets, not a Forbidden that would confirm the id
  // exists. That ordering is deliberate: the role gate must not turn this call into an id oracle.
  it("an out-of-scope id is NotFound for a non-admin, not Forbidden — no id oracle", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeamWithUsers();
    const peer = await makeUser("MEMBER", a.team);
    const theirs = await createAccount(testPrisma, b.suMember, { name: uniq("Theirs ") });
    const login = { name: "Thief", email: `${uniq("thief-")}@test.local`, password: "pw123456" };

    // A real account in another company, an account on their own team they do not manage, and an
    // id that does not exist at all: all three are NotFound, and none is Forbidden.
    for (const id of [theirs.id, "does-not-exist-at-all"]) {
      await expect(createPartnerLogin(testPrisma, a.suMember, id, login)).rejects.toThrow(NotFoundError);
      await expect(createPartnerLogin(testPrisma, a.suMember, id, login)).rejects.not.toThrow(ForbiddenError);
    }
    const mine = await createAccount(testPrisma, a.suMember, { name: uniq("Mine ") });
    await expect(createPartnerLogin(testPrisma, su(peer), mine.id, login)).rejects.toThrow(NotFoundError);

    // A non-admin of ANOTHER company never learns that b's account exists, and nothing was made.
    expect(await testPrisma.user.count({ where: { role: "PARTNER_VIEWER" } })).toBe(0);
  });

  // The gate on createAccountWithLogin runs before ANY write, so a member's attempt to smuggle a
  // partner login in alongside a new account leaves the database exactly as it was — not the
  // account alone, which would be a half-applied request.
  it("a MEMBER's createAccountWithLogin with a partnerLogin creates neither the account nor the login", async () => {
    const t = await makeTeamWithUsers();
    const name = uniq("Smuggled ");
    const email = `${uniq("esc-")}@test.local`;

    await expect(createAccountWithLogin(testPrisma, t.suMember, {
      name, partnerLogin: { name: "Rep", email, password: "pw123456" },
    })).rejects.toThrow(ForbiddenError);

    expect(await testPrisma.account.count({ where: { name } })).toBe(0);
    expect(await testPrisma.user.count({ where: { email } })).toBe(0);
    expect(await testPrisma.user.count({ where: { role: "PARTNER_VIEWER" } })).toBe(0);

    // Creating the ACCOUNT is still a member's job — only ATTACHING a login is not. The same
    // call without partnerLogin succeeds, which is what keeps this a targeted gate rather than a
    // member losing the create path altogether.
    const { account, partnerUser } = await createAccountWithLogin(testPrisma, t.suMember, { name });
    expect(partnerUser).toBeNull();
    expect(account.accountManagerId).toBe(t.member.id);
  });

  it("at most ONE ACTIVE partner login per account — a deactivated one makes room", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: uniq("One ") });
    const first = await createPartnerLogin(testPrisma, t.suAdmin, acc.id, {
      name: "Rep 1", email: `${uniq("r1-")}@test.local`, password: "pw123456",
    });

    await expect(createPartnerLogin(testPrisma, t.suAdmin, acc.id, {
      name: "Rep 2", email: `${uniq("r2-")}@test.local`, password: "pw123456",
    })).rejects.toThrow(PartnerLoginExistsError);
    expect(await testPrisma.user.count({ where: { accountId: acc.id } })).toBe(1);

    await testPrisma.user.update({ where: { id: first.id }, data: { status: "INACTIVE" } });
    await expect(createPartnerLogin(testPrisma, t.suAdmin, acc.id, {
      name: "Rep 2", email: `${uniq("r2b-")}@test.local`, password: "pw123456",
    })).resolves.toBeTruthy();

    // ...and both are listed, revoked one included, masked. LISTING is still open to the account's
    // own MEMBER — the rows are masked and scoped to one account they already manage.
    const logins = await listPartnerLogins(testPrisma, t.suMember, acc.id);
    expect(logins).toHaveLength(2);
    expect(logins.map((l) => l.status).sort()).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("rejects a short password before touching the database", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: uniq("Short ") });
    // An ADMIN caller on purpose: the password check sits after the role gate, so a member's call
    // would be refused for the wrong reason and this test would stop covering the length rule.
    await expect(createPartnerLogin(testPrisma, t.suAdmin, acc.id, {
      name: "Rep", email: `${uniq("s-")}@test.local`, password: "pw1",
    })).rejects.toThrow(/at least 8/);
    expect(await testPrisma.user.count({ where: { accountId: acc.id } })).toBe(0);
  });
});

describe("accounts: the PENDING partner link staked at creation", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  // THE CREATE PATH NO LONGER TALKS TO THE UPSTREAM AT ALL (security review finding F1). It used
  // to resolve the account's name against the live partner list and link on a hit, which made
  // creating an account both a yes/no oracle for "does complex X exist upstream" and an upstream
  // fan-out on an ordinary write. The pending key now comes from the NAME ALONE; verification
  // moved to confirm time, where the actor is the owner who may already see the whole list.
  it("stakes the normalized building name, with no upstream call whatsoever", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Sabah.City", "Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "  komplex   B " });
    expect(acc.externalPartnerKey).toBe("komplex b");
    expect(acc.partnerLinkConfirmedAt).toBeNull();
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  // A name that matches nothing upstream still stakes a claim — and still grants nothing. The
  // claim is about CONTENTION between teams, which is a local question; whether the complex is
  // real is the owner's question, answered at confirm time.
  it("stakes a claim even for a name no upstream complex matches, and grants nothing either way", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Komplex B"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Total Nonsense Ltd" });
    expect(acc.externalPartnerKey).toBe("total nonsense ltd");
    expect(acc.partnerLinkConfirmedAt).toBeNull();
  });

  // Used to be "creates the account UNLINKED when the upstream list is unavailable". There is no
  // upstream call left on this path, so a Django outage is not merely survivable — it is invisible.
  // That is also why tryAutoLink is gone: it existed only to recover from this.
  it("is completely unaffected by a Django outage", async () => {
    vi.mocked(fetchPartners).mockRejectedValue(new Error("ECONNREFUSED"));
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    expect(acc.externalPartnerKey).toBe("komplex b");
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("stakes nothing for a name that normalizes to nothing", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "   " });
    // An empty-string key would be a meaningless claim that exactly one account could hold
    // platform-wide, by virtue of the unique index.
    expect(acc.externalPartnerKey).toBeNull();
  });

  it("writes a DURABLE audit row that outlives the account, the lead, the actor and the company", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });

    const audit = await testPrisma.partnerLinkAudit.findMany();
    expect(audit).toHaveLength(1);
    // Action "pending", not "auto_link": the row records a PROPOSAL. The actor is the salesperson
    // — they really did ask for this link, they just cannot grant it.
    expect(audit[0]).toMatchObject({
      action: "pending", partnerName: "komplex b", accountId: acc.id,
      accountName: "Komplex B", companyId: t.companyId, actorId: t.member.id,
    });
    // The denormalized actor email is what still names a person once the user row is gone.
    const memberEmail = (await testPrisma.user.findUniqueOrThrow({ where: { id: t.member.id } })).email;
    expect(audit[0].actorEmail).toBe(memberEmail);

    // Nothing cascades into this table: deleting the account nulls the FK and KEEPS the row.
    await testPrisma.account.delete({ where: { id: acc.id } });
    const after = await testPrisma.partnerLinkAudit.findMany();
    expect(after).toHaveLength(1);
    expect(after[0].accountId).toBeNull();
    expect(after[0].accountName).toBe("Komplex B");
    expect(after[0].partnerName).toBe("komplex b");
  });

  it("nothing is written to AccountActivity any more — the trail is cascade-proof by construction", async () => {
    const t = await makeTeamWithUsers();
    await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    expect(await testPrisma.accountActivity.count()).toBe(0);
  });

  // THE EXACT-STRING INDEX CANNOT SEE THIS ONE. The rival holds the upstream's display spelling
  // ("Komplex B", as a confirmed link does); our pending key would be "komplex b". Two different
  // strings, so @@unique([externalPartnerKey]) permits both — which would be two accounts claiming
  // one complex. The normalized pre-check in pendingPartnerKey is what refuses it.
  it("stakes nothing when another company's account already holds the complex under a different spelling", async () => {
    const rivalTeam = await makeTeam();
    const rivalMember = await makeUser("MEMBER", rivalTeam);
    await testPrisma.account.create({ data: {
      companyId: rivalTeam.companyId, teamId: rivalTeam.id, name: "Rival",
      buildingKey: buildingKey("Rival"), accountManagerId: rivalMember.id,
      externalPartnerKey: "Komplex B", partnerLinkConfirmedAt: new Date(),
    } });

    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "komplex  b" });
    expect(acc.id).toBeTruthy(); // the sale still goes through
    expect(acc.externalPartnerKey).toBeNull();
    // and no audit row for a link that was never staked
    expect(await testPrisma.partnerLinkAudit.count()).toBe(0);
  });
});

// The DB backstop. Every claim path (the pending stake, the SUPER_ADMIN assign/confirm) reads then
// writes, so on
// its own it is racy: two concurrent creates for one complex can both pass their check and both
// insert. `@@unique([externalPartnerKey])` is what actually makes that impossible — for the
// ordinary collision, where both are pending and so hold the IDENTICAL normalized string. The
// pending-against-confirmed case stores two different spellings and is caught in JS instead; see
// the last test of the describe above.
describe("Account.externalPartnerKey is unique platform-wide", () => {
  beforeEach(prepare);
  afterAll(async () => { restore(); await testPrisma.$disconnect(); });

  it("rejects a second account claiming one complex, even from a different COMPANY", async () => {
    const a = await makeTeamWithUsers();
    const b = await makeTeam();
    const bMember = await makeUser("MEMBER", b);
    await testPrisma.account.create({ data: {
      companyId: a.companyId, teamId: a.team.id, name: "Holder", buildingKey: buildingKey("Holder"),
      accountManagerId: a.member.id, externalPartnerKey: "Komplex B",
    } });

    // Cross-company, not just within one company: one shared X-API-Key means both accounts would
    // read the SAME complex's debt, payments and unit-level owner names/phones.
    await expect(testPrisma.account.create({ data: {
      companyId: b.companyId, teamId: b.id, name: "Thief", buildingKey: buildingKey("Thief"),
      accountManagerId: bMember.id, externalPartnerKey: "Komplex B",
    } })).rejects.toMatchObject({ code: "P2002" });
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
  });

  it("still allows any number of UNLINKED accounts — Postgres ignores NULLs in a unique index", async () => {
    const t = await makeTeamWithUsers();
    // Named with whitespace-only strings so nothing is staked: createAccount DOES stake a pending
    // key off a real name now, so three ordinary creates would be three distinct claims and would
    // not exercise the index's NULL tolerance at all.
    for (const name of ["   ", "  ", "    "]) {
      await testPrisma.account.create({ data: {
        companyId: t.companyId, teamId: t.team.id, name, buildingKey: uniq("bk-"),
        accountManagerId: t.member.id, externalPartnerKey: null,
      } });
    }
    expect(await testPrisma.account.count({ where: { externalPartnerKey: null } })).toBe(3);
  });

  it("absorbs a claim that lands INSIDE the check-then-act window: created, unlinked, no audit row", async () => {
    const t = await makeTeamWithUsers();
    // The rival sits in ANOTHER company, which is the only shape this race has in practice: the
    // partner namespace is global while the building claim is per company, so a cross-company
    // rival takes the partner key without taking the building. (A rival in the SAME company would
    // hold the building too, and the retry is then correctly refused with a 409 rather than
    // degraded — a claimed building is a refusal, not a lost convenience.)
    const rivalTeam = await makeTeam();
    const rivalMember = await makeUser("MEMBER", rivalTeam);

    // Deterministic stand-in for the interleaving no application-level check can prevent: the
    // rival claim commits AFTER pendingPartnerKey reported the key free and BEFORE our own insert
    // runs. Only @@unique([externalPartnerKey]) can catch this. The hook goes on $transaction so it
    // wraps the tx handle createAccount builds internally.
    //
    // The rival takes the NORMALIZED key, which is what a pending claim holds — i.e. the identical
    // string we are about to insert, which is the collision the exact-string index exists to catch.
    let rivalClaimed = false;
    const withRival = (tx: typeof testPrisma) => new Proxy(tx, {
      get(txTarget, txProp, txReceiver) {
        if (txProp !== "account") return Reflect.get(txTarget, txProp, txReceiver);
        return new Proxy(txTarget.account, {
          get(accTarget, accProp, accReceiver) {
            if (accProp !== "create") return Reflect.get(accTarget, accProp, accReceiver);
            return async (args: Parameters<typeof testPrisma.account.create>[0]) => {
              if (!rivalClaimed) {
                rivalClaimed = true;
                // Commits on its OWN connection, so our still-open transaction really loses.
                await testPrisma.account.create({ data: {
                  companyId: rivalTeam.companyId, teamId: rivalTeam.id, name: "Komplex B",
                  buildingKey: buildingKey("Komplex B"), accountManagerId: rivalMember.id,
                  externalPartnerKey: buildingKey("Komplex B"),
                } });
              }
              return txTarget.account.create(args);
            };
          },
        });
      },
    }) as typeof testPrisma;

    const racingDb = new Proxy(testPrisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: typeof testPrisma) => Promise<unknown>) =>
          target.$transaction((tx) => fn(withRival(tx as typeof testPrisma)));
      },
    }) as typeof testPrisma;

    const acc = await createAccount(racingDb, t.suMember, { name: "Komplex B" });

    // Degraded to created-but-unlinked — never to a 500 and never to a missing account.
    expect(acc.name).toBe("Komplex B");
    expect(acc.externalPartnerKey).toBeNull();
    // The rival keeps the sole claim, and no audit row exists for a link that never happened.
    expect(await testPrisma.account.count({ where: { externalPartnerKey: buildingKey("Komplex B") } })).toBe(1);
    expect(await testPrisma.partnerLinkAudit.count()).toBe(0);
  });

  it("a P2002 on externalPartnerKey is distinguishable from one on sourceLeadId, in BOTH Prisma error shapes", () => {
    const known = (meta: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test", meta });

    // Classic engine shape.
    expect(isPartnerKeyConflict(known({ target: ["externalPartnerKey"] }))).toBe(true);
    expect(isPartnerKeyConflict(known({ target: ["sourceLeadId"] }))).toBe(false);

    // The shape this app ACTUALLY gets, from the pg driver adapter — note the embedded quotes and
    // the field buried under driverAdapterError, which is why this check reads the whole meta.
    const adapterShape = (field: string) => ({
      modelName: "Account",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { fields: [`"${field}"`] },
        },
      },
    });
    expect(isPartnerKeyConflict(known(adapterShape("externalPartnerKey")))).toBe(true);
    expect(isPartnerKeyConflict(known(adapterShape("sourceLeadId")))).toBe(false);

    expect(isPartnerKeyConflict(new Error("nope"))).toBe(false);
  });
});
