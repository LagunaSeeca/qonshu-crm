import type { PrismaClient, Team, User } from "@prisma/client";
import { ForbiddenError, NotFoundError, assertRole, type SessionUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { cloneTemplateToTeam, seedOrgTemplate } from "./team-template";

export class InvalidTeamError extends Error {}

// TEAMS ARE WHAT COMPANIES USED TO BE. Qonshu is ONE company; the structure that matters is the
// sales team. The owner (the single SUPER_ADMIN) creates a team together with its one
// COMPANY_ADMIN ("Team Admin" in the UI), and that admin then adds its own MEMBERs through
// users.ts. Every function here is SUPER_ADMIN-only — a team admin can neither create a sibling
// team nor rename its own, because a team's identity is an org-level fact.
//
// This file replaces src/lib/platform/companies.ts (createCompany + its company-wide stage seed),
// which is deleted: provisioning a tenant no longer means creating a Company.

// Resolve the company a super-admin operation acts inside.
//
// The owner's own companyId is authoritative when set (prisma/scripts/super-admin.ts pins it to
// the org). It may legitimately be null — the role predates teams and sits above the org — so
// there are two fallbacks, in order: an explicitly named company, or THE single company if the
// database holds exactly one (which is the production shape). Anything ambiguous throws rather
// than picking a company for the caller.
async function resolveCompanyId(
  db: PrismaClient,
  actor: SessionUser,
  explicit?: string | null,
): Promise<string> {
  if (actor.companyId) {
    if (explicit && explicit !== actor.companyId) throw new ForbiddenError("that company is not yours");
    return actor.companyId;
  }
  if (explicit) {
    const named = await db.company.findUnique({ where: { id: explicit }, select: { id: true } });
    if (!named) throw new NotFoundError("company not found");
    return named.id;
  }
  const companies = await db.company.findMany({ select: { id: true }, take: 2 });
  if (companies.length === 0) throw new NotFoundError("no company exists yet");
  if (companies.length > 1) throw new InvalidTeamError("companyId is required: more than one company exists");
  return companies[0].id;
}

async function requireActiveCompany(db: PrismaClient, companyId: string): Promise<void> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { status: true } });
  if (!company) throw new NotFoundError("company not found");
  if (company.status !== "ACTIVE") throw new InvalidTeamError("company is not active");
}

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new InvalidTeamError("team name is required");
  return trimmed;
}

// A team, its one admin login, and its own copy of the org template — all or nothing.
//
// THE TRANSACTION IS THE POINT: a team with no stages cannot hold a lead, and a team with no
// admin cannot be administered, so a half-built team is worse than no team. The template clone
// runs inside the SAME transaction as the two inserts, and seedOrgTemplate runs first so the very
// first team of a fresh org is seeded from DEFAULT_STAGES instead of from nothing.
//
// Password hashing happens OUTSIDE the transaction on purpose: bcrypt is deliberately slow, and
// holding a write transaction open across it would pin a connection for ~100ms per call.
export async function createTeamWithAdmin(
  db: PrismaClient,
  actor: SessionUser,
  args: {
    name: string;
    adminName: string;
    adminEmail: string;
    adminPassword: string;
    companyId?: string | null;
  },
): Promise<{ team: Team; admin: User }> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const name = cleanName(args.name);
  const companyId = await resolveCompanyId(db, actor, args.companyId);
  await requireActiveCompany(db, companyId);
  const passwordHash = await hashPassword(args.adminPassword);

  return db.$transaction(async (tx) => {
    const team = await tx.team.create({ data: { companyId, name } });
    await seedOrgTemplate(tx, companyId);
    await cloneTemplateToTeam(tx, companyId, team.id);
    const admin = await tx.user.create({
      data: {
        companyId,
        teamId: team.id,
        email: args.adminEmail,
        name: args.adminName,
        passwordHash,
        role: "COMPANY_ADMIN",
        status: "ACTIVE",
      },
    });
    return { team, admin };
  });
}

export type TeamListRow = {
  id: string;
  name: string;
  createdAt: Date;
  // Counts of ACTIVE logins only — a deactivated member is not a seat the owner has to think
  // about when deciding whether a team is staffed.
  admins: number;
  members: number;
  admin: { id: string; name: string; email: string } | null;
};

// Every team in the org, with its admin, for the owner's team list.
export async function listTeams(
  db: PrismaClient,
  actor: SessionUser,
  opts: { companyId?: string | null } = {},
): Promise<TeamListRow[]> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const companyId = await resolveCompanyId(db, actor, opts.companyId);
  const teams = await db.team.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    include: {
      users: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });
  return teams.map((t) => {
    const admins = t.users.filter((u) => u.role === "COMPANY_ADMIN");
    return {
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      admins: admins.length,
      members: t.users.filter((u) => u.role === "MEMBER").length,
      // The model is one admin per team; if a team somehow has two, the earliest-created one is
      // shown rather than an arbitrary row.
      admin: admins[0] ? { id: admins[0].id, name: admins[0].name, email: admins[0].email } : null,
    };
  });
}

// Rename only. A team is never deleted here: Lead.teamId and Account.teamId are RESTRICT
// relations, so "delete team" is really "decide what happens to its book" — a separate decision
// with its own UI, not a side effect of this module.
export async function renameTeam(
  db: PrismaClient,
  actor: SessionUser,
  id: string,
  name: string,
): Promise<Team> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const clean = cleanName(name);
  const companyId = await resolveCompanyId(db, actor);
  const found = await db.team.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!found) throw new NotFoundError("team not found");
  // `@@unique([companyId, name])` is the real guard; a duplicate surfaces as P2002 -> 409 through
  // errorResponse, which is the honest answer (the name is taken) rather than a pre-read that
  // could race another rename.
  return db.team.update({ where: { id: found.id }, data: { name: clean } });
}
