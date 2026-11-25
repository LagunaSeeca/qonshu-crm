import type { Account, OnboardingStep, PrismaClient } from "@prisma/client";
import { assertCan, ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { accountScopeWhere } from "./scope";
import { isStepApplicable } from "./onboarding-template";

// THE ONBOARDING CHECKLIST SERVICE. The six template steps are seeded elsewhere (onboarding-seed.ts);
// this module reads and mutates them. Steps are numbered and shown in `position` order but have NO
// locks: any step can be completed in any order.
//
// AUTHORIZATION = `manage_onboarding` (ONBOARDING, MEMBER, COMPANY_ADMIN, SUPER_ADMIN; never
// PARTNER_VIEWER) AND the parent account being inside the caller's scope (getAccount). Every
// step-id entry point resolves the PARENT ACCOUNT FIRST, so "no such step" and "not your step" are
// one identical NotFoundError (see account-tasks.ts toggleAccountTask).

export type OnboardingStepView = {
  id: string;
  templateKey: string | null;
  title: string;
  position: number;
  done: boolean;
  /** Derived at read time from Account.takesOnlinePayments; never stored. */
  applicable: boolean;
  completedAt: Date | null;
  completedByName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: Date | null;
  note: string | null;
  isCustom: boolean;
};

const MAX_TITLE = 200;
const MAX_NOTE = 2000;

function cleanTitle(raw: string): string {
  const title = (raw ?? "").trim();
  if (!title) throw new Error("title required");
  if (title.length > MAX_TITLE) throw new Error("title too long");
  return title;
}

// One query for every name a list needs (completedBy + assignee), never one per row. The ids are
// bare strings with no relation, and they come from rows we already authorized, so no extra scope.
async function userNames(db: PrismaClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((u) => [u.id, u.name]));
}

function toView(s: OnboardingStep, account: Pick<Account, "takesOnlinePayments">, names: Map<string, string>): OnboardingStepView {
  return {
    id: s.id,
    templateKey: s.templateKey,
    title: s.title,
    position: s.position,
    done: s.done,
    applicable: isStepApplicable(s.templateKey, account.takesOnlinePayments),
    completedAt: s.completedAt,
    completedByName: s.completedById ? names.get(s.completedById) ?? null : null,
    assigneeId: s.assigneeId,
    assigneeName: s.assigneeId ? names.get(s.assigneeId) ?? null : null,
    dueDate: s.dueDate,
    note: s.note,
    isCustom: s.templateKey === null,
  };
}

async function requireAccount(db: PrismaClient, user: SessionUser, accountId: string): Promise<Account> {
  assertCan(user, "manage_onboarding");
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  return account;
}

// Parent account first, child second; one NotFoundError for every failure arm. `expectedAccountId`
// is the account id from the URL, so /accounts/A/onboarding/<step of B> is also a plain 404.
async function requireStep(
  db: PrismaClient, user: SessionUser, stepId: string, expectedAccountId?: string,
): Promise<{ step: OnboardingStep; account: Account }> {
  assertCan(user, "manage_onboarding");
  const found = await db.onboardingStep.findUnique({ where: { id: stepId }, select: { accountId: true } });
  if (!found || (expectedAccountId !== undefined && found.accountId !== expectedAccountId)) {
    throw new NotFoundError("step not in scope");
  }
  const account = await getAccount(db, user, found.accountId);
  if (!account) throw new NotFoundError("step not in scope");
  const step = await db.onboardingStep.findUnique({ where: { id: stepId } });
  if (!step) throw new NotFoundError("step not in scope");
  return { step, account };
}

// WHO MAY BE GIVEN A STEP: only people who can actually open the building. The set is
//   - the account's manager,
//   - every user ASSIGNED to the account (AccountAssignment),
//   - every COMPANY_ADMIN whose teamId is the account's teamId,
// restricted to ACTIVE users of the account's own company. Same derivation as accountScopeWhere.
async function assigneeSet(db: PrismaClient, account: Account): Promise<{ id: string; name: string }[]> {
  return db.user.findMany({
    where: {
      companyId: account.companyId,
      status: "ACTIVE",
      OR: [
        { id: account.accountManagerId },
        { accountAssignments: { some: { accountId: account.id } } },
        { role: "COMPANY_ADMIN", teamId: account.teamId },
      ],
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

async function assertAssignee(db: PrismaClient, account: Account, assigneeId: string): Promise<void> {
  const set = await assigneeSet(db, account);
  if (!set.some((u) => u.id === assigneeId)) throw new ForbiddenError("assignee cannot see this account");
}

export async function listOnboardingAssignees(
  db: PrismaClient, user: SessionUser, accountId: string,
): Promise<{ id: string; name: string }[]> {
  const account = await requireAccount(db, user, accountId);
  return assigneeSet(db, account);
}

export async function listOnboardingSteps(
  db: PrismaClient, user: SessionUser, accountId: string,
): Promise<OnboardingStepView[]> {
  const account = await requireAccount(db, user, accountId);
  const steps = await db.onboardingStep.findMany({ where: { accountId: account.id }, orderBy: { position: "asc" } });
  const names = await userNames(db, steps.flatMap((s) => [s.completedById, s.assigneeId]));
  return steps.map((s) => toView(s, account, names));
}

export async function addOnboardingStep(
  db: PrismaClient, user: SessionUser, accountId: string,
  args: { title: string; assigneeId?: string | null; dueDate?: Date | null },
): Promise<OnboardingStepView> {
  const account = await requireAccount(db, user, accountId);
  const title = cleanTitle(args.title);
  if (args.assigneeId != null) await assertAssignee(db, account, args.assigneeId);
  const max = await db.onboardingStep.aggregate({ where: { accountId: account.id }, _max: { position: true } });
  const created = await db.onboardingStep.create({
    data: {
      companyId: account.companyId,
      accountId: account.id,
      templateKey: null,
      title,
      position: (max._max.position ?? 0) + 1,
      assigneeId: args.assigneeId ?? null,
      dueDate: args.dueDate ?? null,
      createdById: user.id,
    },
  });
  const names = await userNames(db, [created.assigneeId]);
  return toView(created, account, names);
}

export async function updateOnboardingStep(
  db: PrismaClient, user: SessionUser, stepId: string,
  patch: { done?: boolean; assigneeId?: string | null; dueDate?: Date | null; note?: string | null },
  expectedAccountId?: string,
): Promise<OnboardingStepView> {
  const { account } = await requireStep(db, user, stepId, expectedAccountId);
  const data: Record<string, unknown> = {};
  if (patch.done !== undefined) {
    data.done = patch.done;
    data.completedById = patch.done ? user.id : null;
    data.completedAt = patch.done ? new Date() : null;
  }
  if (patch.assigneeId !== undefined) {
    if (patch.assigneeId !== null) await assertAssignee(db, account, patch.assigneeId);
    data.assigneeId = patch.assigneeId;
  }
  if (patch.dueDate !== undefined) data.dueDate = patch.dueDate;
  if (patch.note !== undefined) {
    const note = patch.note === null ? null : patch.note.trim();
    if (note && note.length > MAX_NOTE) throw new Error("note too long");
    data.note = note || null;
  }
  const updated = await db.onboardingStep.update({ where: { id: stepId }, data });
  const names = await userNames(db, [updated.completedById, updated.assigneeId]);
  return toView(updated, account, names);
}

// Custom steps only: the six template steps are the company's fixed process, and progress must
// stay comparable across buildings.
export async function deleteOnboardingStep(
  db: PrismaClient, user: SessionUser, stepId: string, expectedAccountId?: string,
): Promise<void> {
  const { step } = await requireStep(db, user, stepId, expectedAccountId);
  if (step.templateKey !== null) throw new ForbiddenError("template steps cannot be deleted");
  await db.onboardingStep.delete({ where: { id: stepId } });
}

// On THIS service rather than updateAccount so ONBOARDING staff (no edit_accounts) can answer it.
export async function setTakesOnlinePayments(
  db: PrismaClient, user: SessionUser, accountId: string, value: boolean | null,
): Promise<boolean | null> {
  const account = await requireAccount(db, user, accountId);
  const updated = await db.account.update({ where: { id: account.id }, data: { takesOnlinePayments: value } });
  return updated.takesOnlinePayments;
}

export type OnboardingQueueRow = {
  accountId: string; accountName: string; teamName: string; managerName: string;
  done: number; total: number; nextStepTitle: string | null;
  myOpenCount: number; overdueCount: number; hasOnboardingAssignee: boolean;
};

// Accounts in the caller's scope with at least one OPEN APPLICABLE step. Two queries total: all
// steps of in-scope accounts (account name/team/manager joined in), and one assignment lookup for
// the ONBOARDING users of those accounts; everything else folds in memory.
export async function listOnboardingQueue(
  db: PrismaClient, user: SessionUser, opts: { mine?: boolean } = {},
): Promise<OnboardingQueueRow[]> {
  assertCan(user, "manage_onboarding");
  const steps = await db.onboardingStep.findMany({
    where: { account: accountScopeWhere(user) },
    orderBy: [{ accountId: "asc" }, { position: "asc" }],
    include: {
      account: {
        select: {
          id: true, name: true, takesOnlinePayments: true,
          team: { select: { name: true } }, accountManager: { select: { name: true } },
        },
      },
    },
  });
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  type Acc = OnboardingQueueRow & { openApplicable: number };
  const byAccount = new Map<string, Acc>();
  for (const s of steps) {
    if (!isStepApplicable(s.templateKey, s.account.takesOnlinePayments)) continue;
    let row = byAccount.get(s.accountId);
    if (!row) {
      row = {
        accountId: s.accountId, accountName: s.account.name, teamName: s.account.team.name,
        managerName: s.account.accountManager.name, done: 0, total: 0, nextStepTitle: null,
        myOpenCount: 0, overdueCount: 0, hasOnboardingAssignee: false, openApplicable: 0,
      };
      byAccount.set(s.accountId, row);
    }
    row.total += 1;
    if (s.done) { row.done += 1; continue; }
    row.openApplicable += 1;
    const isMine = s.assigneeId === user.id;
    if (isMine) row.myOpenCount += 1;
    if (s.dueDate && s.dueDate < today && (!opts.mine || isMine)) row.overdueCount += 1;
    if (row.nextStepTitle === null && (!opts.mine || isMine)) row.nextStepTitle = s.title;
  }

  const rows = [...byAccount.values()].filter((r) => r.openApplicable > 0 && (!opts.mine || r.myOpenCount > 0));
  if (rows.length === 0) return [];
  const onboarders = await db.accountAssignment.findMany({
    where: { accountId: { in: rows.map((r) => r.accountId) }, user: { role: "ONBOARDING", status: "ACTIVE" } },
    select: { accountId: true },
  });
  const staffed = new Set(onboarders.map((a) => a.accountId));
  return rows
    .map(({ openApplicable: _o, ...r }) => ({ ...r, hasOnboardingAssignee: staffed.has(r.accountId) }))
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
}

// !!! NO USER ARGUMENT, NO SCOPE CHECK. The CALLER must pass ids it has ALREADY filtered through
// accountScopeWhere/getAccount (e.g. the ids of an account list it just authorized). Passing
// unscoped ids leaks progress for buildings the viewer cannot open. Counts APPLICABLE steps only,
// so a building without online payments reads "5 of 5", never "5 of 6".
export async function getOnboardingProgress(
  db: PrismaClient, accountIds: string[],
): Promise<Map<string, { done: number; total: number }>> {
  const out = new Map<string, { done: number; total: number }>();
  if (accountIds.length === 0) return out;
  const steps = await db.onboardingStep.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, templateKey: true, done: true, account: { select: { takesOnlinePayments: true } } },
  });
  for (const s of steps) {
    if (!isStepApplicable(s.templateKey, s.account.takesOnlinePayments)) continue;
    const p = out.get(s.accountId) ?? { done: 0, total: 0 };
    p.total += 1;
    if (s.done) p.done += 1;
    out.set(s.accountId, p);
  }
  return out;
}
