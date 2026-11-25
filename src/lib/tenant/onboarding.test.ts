import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeamWithUsers, makeUser, makeTeam, su, uniq, buildingKey } from "@/test/fixtures";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { ONBOARDING_TEMPLATE, PAYMENT_STEP_KEY } from "./onboarding-template";
import {
  listOnboardingSteps, addOnboardingStep, updateOnboardingStep, deleteOnboardingStep,
  setTakesOnlinePayments, listOnboardingAssignees, listOnboardingQueue, getOnboardingProgress,
} from "./onboarding";

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await testPrisma.$disconnect(); });

// Steps are seeded by another module; seed them directly here.
async function makeAccount(team: { id: string; companyId: string }, managerId: string, takesOnlinePayments: boolean | null = null) {
  const name = uniq("Bldg ");
  const account = await testPrisma.account.create({
    data: { companyId: team.companyId, teamId: team.id, name, buildingKey: buildingKey(name), accountManagerId: managerId, takesOnlinePayments },
  });
  await testPrisma.onboardingStep.createMany({
    data: ONBOARDING_TEMPLATE.map((t, i) => ({
      companyId: team.companyId, accountId: account.id, templateKey: t.key, title: t.title, position: i + 1,
    })),
  });
  return account;
}
async function assign(accountId: string, userId: string, companyId: string) {
  await testPrisma.accountAssignment.create({ data: { companyId, accountId, userId } });
}

async function world() {
  const t = await makeTeamWithUsers();
  const onboarder = await makeUser("ONBOARDING", t.team, { name: "Onboarder" });
  const account = await makeAccount(t.team, t.member.id);
  await assign(account.id, onboarder.id, t.companyId);
  return { ...t, onboarder, suOnb: su(onboarder), account };
}
const stepByKey = async (accountId: string, key: string) =>
  testPrisma.onboardingStep.findFirstOrThrow({ where: { accountId, templateKey: key } });

describe("onboarding checklist", () => {
  it("lists steps in position order; any order of completion works and un-ticking clears the stamp", async () => {
    const w = await world();
    const steps = await listOnboardingSteps(testPrisma, w.suMember, w.account.id);
    expect(steps.map((s) => s.templateKey)).toEqual(ONBOARDING_TEMPLATE.map((t) => t.key));

    const last = steps[5], first = steps[0];
    const done = await updateOnboardingStep(testPrisma, w.suOnb, last.id, { done: true });
    expect(done.done).toBe(true);
    expect(done.completedByName).toBe("Onboarder");
    expect(done.completedAt).toBeInstanceOf(Date);
    await updateOnboardingStep(testPrisma, w.suMember, first.id, { done: true }); // out of order, no lock

    const undone = await updateOnboardingStep(testPrisma, w.suOnb, last.id, { done: false });
    expect(undone.done).toBe(false);
    const row = await testPrisma.onboardingStep.findUniqueOrThrow({ where: { id: last.id } });
    expect(row.completedById).toBeNull();
    expect(row.completedAt).toBeNull();
  });

  it("step 1 is not applicable and excluded from progress when takesOnlinePayments is false", async () => {
    const w = await world();
    let steps = await listOnboardingSteps(testPrisma, w.suMember, w.account.id);
    expect(steps[0].applicable).toBe(true); // null = not yet asked
    expect((await getOnboardingProgress(testPrisma, [w.account.id])).get(w.account.id)).toEqual({ done: 0, total: 6 });

    await setTakesOnlinePayments(testPrisma, w.suOnb, w.account.id, false); // ONBOARDING may answer it
    steps = await listOnboardingSteps(testPrisma, w.suMember, w.account.id);
    expect(steps[0].templateKey).toBe(PAYMENT_STEP_KEY);
    expect(steps[0].applicable).toBe(false);
    expect(steps.slice(1).every((s) => s.applicable)).toBe(true);
    expect((await getOnboardingProgress(testPrisma, [w.account.id])).get(w.account.id)).toEqual({ done: 0, total: 5 });

    await setTakesOnlinePayments(testPrisma, w.suMember, w.account.id, true);
    expect((await getOnboardingProgress(testPrisma, [w.account.id])).get(w.account.id)).toEqual({ done: 0, total: 6 });
  });

  it("template steps cannot be deleted; custom steps can, and get the next position", async () => {
    const w = await world();
    const tpl = await stepByKey(w.account.id, "TRAIN_MANAGERS");
    await expect(deleteOnboardingStep(testPrisma, w.suMember, tpl.id)).rejects.toBeInstanceOf(ForbiddenError);

    const custom = await addOnboardingStep(testPrisma, w.suMember, w.account.id, { title: "  Install intercom  " });
    expect(custom.title).toBe("Install intercom");
    expect(custom.isCustom).toBe(true);
    expect(custom.position).toBe(7);
    await expect(addOnboardingStep(testPrisma, w.suMember, w.account.id, { title: "   " })).rejects.toThrow();
    await deleteOnboardingStep(testPrisma, w.suMember, custom.id);
    expect(await testPrisma.onboardingStep.count({ where: { id: custom.id } })).toBe(0);
  });

  it("assignee must be the manager, an assigned user, or an active team admin of the account", async () => {
    const w = await world();
    const step = await stepByKey(w.account.id, "RESIDENT_SMS");
    const outsider = await makeUser("ONBOARDING", w.team);          // same company, not assigned
    const otherTeam = await makeTeam({ companyId: w.companyId });
    const otherAdmin = await makeUser("COMPANY_ADMIN", otherTeam);   // admin of a different team
    const otherCompany = await makeTeamWithUsers();

    for (const bad of [outsider.id, otherAdmin.id, otherCompany.member.id, "no-such-user"]) {
      await expect(updateOnboardingStep(testPrisma, w.suMember, step.id, { assigneeId: bad })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addOnboardingStep(testPrisma, w.suMember, w.account.id, { title: "x", assigneeId: bad })).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const good of [w.member.id, w.onboarder.id, w.admin.id]) {
      const v = await updateOnboardingStep(testPrisma, w.suMember, step.id, { assigneeId: good });
      expect(v.assigneeId).toBe(good);
      expect(v.assigneeName).toBeTruthy();
    }
    const cleared = await updateOnboardingStep(testPrisma, w.suMember, step.id, { assigneeId: null, note: "  hi " });
    expect(cleared.assigneeId).toBeNull();
    expect(cleared.note).toBe("hi");

    const ids = (await listOnboardingAssignees(testPrisma, w.suMember, w.account.id)).map((u) => u.id).sort();
    expect(ids).toEqual([w.member.id, w.onboarder.id, w.admin.id].sort());
  });

  it("an assigned ONBOARDING user can list and complete; an unassigned one gets NotFound", async () => {
    const w = await world();
    const steps = await listOnboardingSteps(testPrisma, w.suOnb, w.account.id);
    expect(steps).toHaveLength(6);
    await updateOnboardingStep(testPrisma, w.suOnb, steps[1].id, { done: true });

    const stranger = su(await makeUser("ONBOARDING", w.team));
    await expect(listOnboardingSteps(testPrisma, stranger, w.account.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateOnboardingStep(testPrisma, stranger, steps[1].id, { done: false })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setTakesOnlinePayments(testPrisma, stranger, w.account.id, true)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a MEMBER on another member's building gets NotFound; PARTNER_VIEWER is Forbidden", async () => {
    const w = await world();
    const other = su(await makeUser("MEMBER", w.team));
    await expect(listOnboardingSteps(testPrisma, other, w.account.id)).rejects.toBeInstanceOf(NotFoundError);
    const step = await stepByKey(w.account.id, "TRAIN_MANAGERS");
    await expect(updateOnboardingStep(testPrisma, other, step.id, { done: true })).rejects.toBeInstanceOf(NotFoundError);

    const viewer = su(await makeUser("PARTNER_VIEWER", w.team, { accountId: w.account.id }));
    await expect(listOnboardingSteps(testPrisma, viewer, w.account.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOnboardingStep(testPrisma, viewer, step.id, { done: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listOnboardingQueue(testPrisma, viewer)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a step id from another account is the same NotFoundError as an invented id", async () => {
    const w = await world();
    const foreign = await makeAccount(w.team, w.admin.id); // member/onboarder cannot see this one
    const foreignStep = await stepByKey(foreign.id, "TRAIN_MANAGERS");
    const real = await stepByKey(w.account.id, "TRAIN_MANAGERS");

    const msg = async (fn: () => Promise<unknown>) => fn().then(() => "ok", (e) => `${e.constructor.name}:${e.message}`);
    const a = await msg(() => updateOnboardingStep(testPrisma, w.suMember, foreignStep.id, { done: true }));
    const b = await msg(() => updateOnboardingStep(testPrisma, w.suMember, "invented-id", { done: true }));
    expect(a).toBe(b);
    expect(a.startsWith("NotFoundError")).toBe(true);
    expect(await msg(() => deleteOnboardingStep(testPrisma, w.suMember, foreignStep.id))).toBe(b);
    // URL account mismatch (own step id under someone else's account id) is also a plain 404.
    expect(await msg(() => updateOnboardingStep(testPrisma, w.suMember, real.id, { done: true }, foreign.id))).toBe(b);
  });

  it("queue lists accounts with open applicable steps, supports mine, flags unstaffed buildings", async () => {
    const w = await world();
    const unstaffed = await makeAccount(w.team, w.member.id);
    const finished = await makeAccount(w.team, w.member.id, false);
    await testPrisma.onboardingStep.updateMany({ where: { accountId: finished.id, templateKey: { not: PAYMENT_STEP_KEY } }, data: { done: true } });

    const steps = await listOnboardingSteps(testPrisma, w.suMember, w.account.id);
    await updateOnboardingStep(testPrisma, w.suMember, steps[2].id, { assigneeId: w.member.id, dueDate: new Date("2020-01-01T00:00:00.000Z") });
    await updateOnboardingStep(testPrisma, w.suMember, steps[1].id, { done: true });

    const queue = await listOnboardingQueue(testPrisma, w.suAdmin);
    const ids = queue.map((q) => q.accountId);
    expect(ids).toContain(w.account.id);
    expect(ids).toContain(unstaffed.id);
    expect(ids).not.toContain(finished.id); // only the inapplicable step is open
    const row = queue.find((q) => q.accountId === w.account.id)!;
    expect(row).toMatchObject({ done: 1, total: 6, myOpenCount: 0, overdueCount: 1, hasOnboardingAssignee: true });
    expect(row.nextStepTitle).toBe(steps[0].title);
    expect(queue.find((q) => q.accountId === unstaffed.id)!.hasOnboardingAssignee).toBe(false);

    const mine = await listOnboardingQueue(testPrisma, w.suMember, { mine: true });
    expect(mine.map((q) => q.accountId)).toEqual([w.account.id]);
    expect(mine[0].myOpenCount).toBe(1);

    // ONBOARDING sees only the building it is assigned to.
    expect((await listOnboardingQueue(testPrisma, w.suOnb)).map((q) => q.accountId)).toEqual([w.account.id]);
  });
});
