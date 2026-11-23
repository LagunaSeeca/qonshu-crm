import type { PrismaClient, AccountFieldDef, AccountFieldType } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

// CUSTOM ACCOUNT FIELDS ARE PER TEAM.
//
// Each team runs its own book and wants its own columns, so two teams may each define a "Total
// area" field and they are different fields with different values. A definition row with
// `teamId: null` is the ORG-LEVEL TEMPLATE: the set a newly created team is seeded from. Template
// rows never carry values.
//
// WHO EDITS WHAT:
//   COMPANY_ADMIN  its own team's live definitions
//   MEMBER         reads them (the write routes are admin-gated); never another team's
//   SUPER_ADMIN    the TEMPLATE and any team's set, but only by NAMING it (resolveFieldDefScope):
//                  it has no team of its own, so there is nothing to default to
//
// Scoped reads and writes BOTH start from a FieldDefScope, so "which set am I touching" is decided
// once rather than per function. The API routes resolve it with resolveFieldDefScope; callers that
// only want the caller's own set use defScopeWhere.

export type FieldDefScope = { companyId: string; teamId: string | null };

// The `{ companyId, teamId }` pair every definition read/write must start from.
//
// `teamId: null` is a REAL VALUE here, not an absent filter — it selects the template. That is
// precisely why this returns an explicit pair instead of a spreadable partial: a dropped `teamId`
// key would widen the query from one team to every team in the org, and a WHERE missing a key is
// the whole table rather than a smaller result set.
export function defScopeWhere(user: SessionUser): FieldDefScope {
  if (user.role === "PARTNER_VIEWER") throw new ForbiddenError("partners cannot read field definitions");
  // A SUPER_ADMIN sits above every company and so has companyId null (see scope.ts). The template
  // still belongs to a company, so the caller must supply the context — same contract as every
  // other scope helper, and the same fail-closed answer when it does not.
  if (!user.companyId) throw new ForbiddenError(`no company context for ${user.role}`);
  if (user.role === "SUPER_ADMIN") return { companyId: user.companyId, teamId: null };
  // Dropping teamId for an admin/member with no team would show them every team's definitions.
  if (!user.teamId) throw new ForbiddenError(`${user.role} is not on a team`);
  if (user.role === "COMPANY_ADMIN" || user.role === "MEMBER") {
    return { companyId: user.companyId, teamId: user.teamId };
  }
  throw new ForbiddenError(`role ${user.role} has no field definition scope`);
}

export type FieldDefScopeRequest = {
  // undefined = not named; null = the org template; string = that team.
  teamId?: string | null;
  // Only read for the template, where there is no team to derive the company from.
  companyId?: string;
};

// The async counterpart to defScopeWhere for requests that may NAME a scope. Mirrors
// resolveStageScope (./stages.ts) so both settings pages behave identically.
export async function resolveFieldDefScope(
  db: Pick<PrismaClient, "team">,
  user: SessionUser,
  requested: FieldDefScopeRequest = {},
): Promise<FieldDefScope> {
  if (user.role === "PARTNER_VIEWER") throw new ForbiddenError("partners cannot read field definitions");

  if (user.role === "SUPER_ADMIN") {
    // REQUIRED, not defaulted: a SUPER_ADMIN has no team, and guessing one would edit the wrong
    // team's definitions.
    if (requested.teamId === undefined) {
      throw new ForbiddenError("a super admin must name the team (or ?teamId= for the org template)");
    }
    if (requested.teamId === null) {
      const companyId = requested.companyId ?? user.companyId;
      if (!companyId) throw new ForbiddenError("a super admin must name the company for the field template");
      return { companyId, teamId: null };
    }
    const team = await db.team.findUnique({
      where: { id: requested.teamId },
      select: { id: true, companyId: true },
    });
    if (!team) throw new NotFoundError("team not found");
    return { companyId: team.companyId, teamId: team.id };
  }

  if (user.role === "COMPANY_ADMIN" || user.role === "MEMBER") {
    if (!user.companyId) throw new ForbiddenError(`no company context for ${user.role}`);
    if (!user.teamId) throw new ForbiddenError(`${user.role} is not on a team`);
    // The template seeds every future team; one team's admin must not reshape it.
    if (requested.teamId === null) throw new ForbiddenError("the org field template is super-admin only");
    if (requested.teamId !== undefined && requested.teamId !== user.teamId) {
      throw new ForbiddenError("not your team");
    }
    return { companyId: user.companyId, teamId: user.teamId };
  }

  throw new ForbiddenError(`role ${user.role} has no field definition scope`);
}

// `@@unique([teamId, label])` does NOT police the template, because Postgres treats NULLs as
// DISTINCT in a unique index — two rows with teamId NULL and the same label both insert happily
// (empirically confirmed against this schema). Prisma cannot express the partial unique index
// (`UNIQUE (label) WHERE teamId IS NULL`) that would close it, so the rule is enforced here, in
// app code, scoped by (companyId, label).
//
// Only the template needs this: for a real team the database constraint already refuses.
async function assertLabelFree(
  db: PrismaClient, scope: FieldDefScope, label: string, exceptId?: string,
): Promise<void> {
  if (scope.teamId !== null) return;
  const clash = await db.accountFieldDef.findFirst({
    where: {
      companyId: scope.companyId, teamId: null, label,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new ForbiddenError(`a template field named "${label}" already exists`);
}

// Each function below takes an optional pre-resolved `scope` (from resolveFieldDefScope). Omitted,
// it falls back to the caller's own set via defScopeWhere.
export function listFieldDefs(db: PrismaClient, user: SessionUser, scope: FieldDefScope = defScopeWhere(user)): Promise<AccountFieldDef[]> {
  return db.accountFieldDef.findMany({ where: scope, orderBy: { order: "asc" } });
}

export async function createFieldDef(db: PrismaClient, user: SessionUser, data: { label: string; type: AccountFieldType }, scope: FieldDefScope = defScopeWhere(user)): Promise<AccountFieldDef> {
  await assertLabelFree(db, scope, data.label);
  // `order` is per set, so a new team's first field starts at 0 even though the org has others.
  const max = await db.accountFieldDef.aggregate({ where: scope, _max: { order: true } });
  return db.accountFieldDef.create({
    data: { ...scope, label: data.label, type: data.type, order: (max._max.order ?? -1) + 1 },
  });
}

export async function updateFieldDef(db: PrismaClient, user: SessionUser, id: string, data: Partial<{ label: string; type: AccountFieldType }>, scope: FieldDefScope = defScopeWhere(user)): Promise<AccountFieldDef> {
  // `...scope` and not `{ companyId }`: without the teamId a team admin could rename a sibling
  // team's field — and a super admin a live team's — by naming its id.
  const found = await db.accountFieldDef.findFirst({ where: { id, ...scope } });
  if (!found) throw new NotFoundError("field def not in scope");
  if (data.label !== undefined && data.label !== found.label) {
    await assertLabelFree(db, scope, data.label, id);
  }
  return db.accountFieldDef.update({ where: { id }, data });
}

export async function deleteFieldDef(db: PrismaClient, user: SessionUser, id: string, scope: FieldDefScope = defScopeWhere(user)): Promise<void> {
  const found = await db.accountFieldDef.findFirst({ where: { id, ...scope } });
  if (!found) throw new NotFoundError("field def not in scope");
  await db.accountFieldDef.delete({ where: { id } });
}

export async function reorderFieldDefs(db: PrismaClient, user: SessionUser, orderedIds: string[], scope: FieldDefScope = defScopeWhere(user)): Promise<void> {
  // updateMany with the scope in the WHERE, so an id from another team's set matches nothing
  // instead of being silently reordered into this one.
  await db.$transaction(
    orderedIds.map((id, i) => db.accountFieldDef.updateMany({ where: { id, ...scope }, data: { order: i } })),
  );
}

export type AccountFieldRow = { fieldDefId: string; label: string; type: AccountFieldType; order: number; value: string };

// VALUES FOLLOW THE ACCOUNT'S TEAM, not the reader's.
//
// Keyed off `account.teamId` rather than `user.teamId` so the account shows the same fields to
// everyone who can legitimately open it — its manager, their team admin, a super admin — and so a
// transferred account immediately reads against its NEW team's definitions (see
// remapFieldValuesToTeam in ./accounts.ts, which moves the values to match).
export async function getAccountFields(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountFieldRow[]> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const [defs, values] = await Promise.all([
    db.accountFieldDef.findMany({
      where: { companyId: acc.companyId, teamId: acc.teamId }, orderBy: { order: "asc" },
    }),
    db.accountFieldValue.findMany({ where: { companyId: acc.companyId, accountId } }),
  ]);
  const valueMap = new Map(values.map((v) => [v.fieldDefId, v.value]));
  return defs.map((d) => ({
    fieldDefId: d.id,
    label: d.label,
    type: d.type,
    order: d.order,
    value: valueMap.get(d.id) ?? "",
  }));
}

export async function setAccountFieldValue(db: PrismaClient, user: SessionUser, accountId: string, fieldDefId: string, value: string) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  // The definition must belong to THIS ACCOUNT'S TEAM. A `{ id, companyId }` lookup accepted any
  // definition in the org — including the template, whose rows must never carry values, and
  // another team's field, which would have shown that team a value from a book they cannot see.
  const def = await db.accountFieldDef.findFirst({
    where: { id: fieldDefId, companyId: acc.companyId, teamId: acc.teamId },
    select: { id: true },
  });
  if (!def) throw new NotFoundError("field def not in scope");
  return db.accountFieldValue.upsert({
    where: { accountId_fieldDefId: { accountId, fieldDefId } },
    create: { companyId: acc.companyId, accountId, fieldDefId, value },
    update: { value },
  });
}
