import type { PrismaClient } from "@prisma/client";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

// WHAT THIS REPLACES: the old visibility.ts, whose member-isolation branch was
// `if (shareAllLeads || role === COMPANY_ADMIN) return { companyId }` with `shareAllLeads ??
// true` — i.e. share-everything by default, configurable per company, and company-wide rather
// than team-wide. Company.shareAllLeads is gone and so is that branch. The rules here are
// absolute and not configurable:
//
//   SUPER_ADMIN    every team in the company it is scoped to
//   COMPANY_ADMIN  its own team, all owners ("Team Admin")
//   MEMBER         its own rows only — ALWAYS, with no setting that widens it
//   PARTNER_VIEWER no CRM at all; exactly one Account
//
// Every rule fails closed: a missing companyId, a missing teamId where one is required, or a
// role this module does not know, all raise ForbiddenError rather than degrading to a broader
// filter. A where-clause missing a key is not a smaller result set, it is the whole table — so
// an absent value can never be allowed to mean "no filter".
//
// SYNCHRONOUS and DB-FREE on purpose. The old leadScopeWhere ran a Company lookup on every
// single lead read just to fetch the toggle. The scope is now entirely a function of the
// session, so it is a pure function — which is also why it can be unit-tested exhaustively
// without a database (see scope.test.ts).

export type LeadScope = { companyId: string; teamId?: string; ownerId?: string };
export type AccountScope = { companyId: string; teamId?: string; accountManagerId?: string; id?: string };

// A PARTNER_VIEWER whose accountId is unset is a data bug; the sentinel makes the resulting
// query match nothing instead of matching the whole company. An `id` filter is never omitted
// for a partner.
const NO_ACCESS = "__no_access__";

// NOTE ON SUPER_ADMIN: in this model a SUPER_ADMIN has companyId null (it sits above every
// company), so it cannot pass through here at all — it fails closed on the companyId check.
// That is deliberate and matches how super-admin reads already work: the sanctioned
// cross-company paths live in src/lib/platform/* behind assertRole(["SUPER_ADMIN"]) with an
// EXPLICIT companyId, never through tenant scope. The SUPER_ADMIN branch below is what applies
// once a caller gives the super admin a concrete company context to act inside: company-wide,
// every team, no owner filter.
function requireCompany(user: SessionUser): string {
  if (!user.companyId) {
    throw new ForbiddenError(
      `no company context for ${user.role}` +
        (user.role === "SUPER_ADMIN" ? " — super-admin reads must name a company explicitly" : ""),
    );
  }
  return user.companyId;
}

// A COMPANY_ADMIN or MEMBER with no team has no book to see. Returning `{ companyId }` here —
// dropping the teamId key — would show them every team in the company, so this throws.
function requireTeam(user: SessionUser): string {
  if (!user.teamId) throw new ForbiddenError(`${user.role} is not on a team`);
  return user.teamId;
}

// The WHERE every tenant-scoped Lead read must start from.
//
// It lives here rather than in leads.ts so lead-conversion.ts can scope its own lead lookup
// without importing leads.ts: leads.ts imports lead-conversion.ts for auto-convert-on-Won, and
// that pair has to stay acyclic.
export function leadScopeWhere(user: SessionUser): LeadScope {
  // Partner logins never see the sales pipeline — CRM, dashboard, reports and "my work" all
  // resolve their scope through this function, so this single check blocks all of them.
  if (user.role === "PARTNER_VIEWER") throw new ForbiddenError("partners cannot access the CRM");
  const companyId = requireCompany(user);
  if (user.role === "SUPER_ADMIN") return { companyId };
  const teamId = requireTeam(user);
  if (user.role === "COMPANY_ADMIN") return { companyId, teamId };
  if (user.role === "MEMBER") return { companyId, teamId, ownerId: user.id };
  // Unreachable today. Kept so that adding a Role without revisiting this file is a 403 rather
  // than an unscoped read.
  throw new ForbiddenError(`role ${user.role} has no lead scope`);
}

// Same rules as leadScopeWhere, keyed on accountManagerId instead of ownerId. Moved out of
// accounts.ts, where it was `{ companyId }` for every role and the partner/member narrowing was
// re-implemented ad hoc by each caller.
export function accountScopeWhere(user: SessionUser): AccountScope {
  const companyId = requireCompany(user);
  // Not a throw: a partner login's whole purpose is its one account. The id filter is what
  // confines it, and it is always present.
  if (user.role === "PARTNER_VIEWER") return { companyId, id: user.accountId ?? NO_ACCESS };
  if (user.role === "SUPER_ADMIN") return { companyId };
  const teamId = requireTeam(user);
  if (user.role === "COMPANY_ADMIN") return { companyId, teamId };
  if (user.role === "MEMBER") return { companyId, teamId, accountManagerId: user.id };
  throw new ForbiddenError(`role ${user.role} has no account scope`);
}

export type AssignableOwner = { ownerId: string; teamId: string };

// Accepts a PrismaClient or an interactive-transaction client, so a caller already inside
// $transaction can resolve the owner under the same transaction as the write.
type UserReader = Pick<PrismaClient, "user">;

const OWNABLE_ROLES: readonly string[] = ["COMPANY_ADMIN", "MEMBER"];

// Who a new Lead/Account may be assigned to, and the team the row therefore belongs to. The
// returned teamId is NOT the actor's team in the super-admin case — it is the OWNER's — so
// callers must write the pair this returns together and never mix one with a teamId of their
// own. (companyId likewise follows the owner's team; this helper returns only the two fields
// the contract fixes, so derive companyId from teamId at the write site.)
//
// The owner is always validated against the database, never taken on trust from the request:
// an ownerId is client input, and it decides which team's book a row lands in.
export async function resolveAssignableOwner(
  db: UserReader,
  user: SessionUser,
  ownerId?: string,
): Promise<AssignableOwner> {
  if (user.role === "PARTNER_VIEWER") throw new ForbiddenError("partners cannot own records");

  // A MEMBER is ALWAYS the owner of what it creates. A supplied ownerId is ignored outright
  // rather than rejected: every create form posts the field, and a member who tampers with it
  // is trying to put a row in someone else's book — which must not be an error the client can
  // probe for, just a value with no effect. This path needs no DB call at all.
  if (user.role === "MEMBER") {
    requireCompany(user);
    return { ownerId: user.id, teamId: requireTeam(user) };
  }

  if (user.role === "COMPANY_ADMIN") {
    const companyId = requireCompany(user);
    const teamId = requireTeam(user);
    // Default to self, and short-circuit self: the session was re-read from the row on this
    // request (see session.ts), so the actor is already known-ACTIVE.
    if (!ownerId || ownerId === user.id) return { ownerId: user.id, teamId };
    const candidate = await loadOwnable(db, ownerId);
    // Own team only — a team admin cannot park work in a sibling team's book.
    if (candidate.companyId !== companyId || candidate.teamId !== teamId) {
      throw new ForbiddenError("owner is not on your team");
    }
    return { ownerId: candidate.id, teamId };
  }

  if (user.role === "SUPER_ADMIN") {
    // REQUIRED, not defaulted: a super admin has no team, so there is no sane fallback, and a
    // silent one would plant the row in whichever team a later line happened to pick.
    if (!ownerId) throw new ForbiddenError("a super admin must name the owner explicitly");
    const candidate = await loadOwnable(db, ownerId);
    if (!candidate.teamId) throw new ForbiddenError("owner is not on a team");
    return { ownerId: candidate.id, teamId: candidate.teamId };
  }

  throw new ForbiddenError(`role ${user.role} cannot assign owners`);
}

// One primary-key lookup, three fail-closed checks. Notably this is what stops a SUPER_ADMIN or
// a PARTNER_VIEWER from ever becoming an owner: neither role is ownable, so neither can be
// named — a super admin has no team for the row to belong to, and a partner login must never
// appear in a team's book.
async function loadOwnable(db: UserReader, ownerId: string) {
  const row = await db.user.findUnique({
    where: { id: ownerId },
    select: { id: true, role: true, status: true, companyId: true, teamId: true },
  });
  // ForbiddenError, not NotFoundError: "that id is not assignable" is the same answer whether
  // the user does not exist, is deactivated or is the wrong role, and the caller has no
  // business learning which.
  if (!row) throw new ForbiddenError("owner is not assignable");
  if (row.status !== "ACTIVE") throw new ForbiddenError("owner is not active");
  if (!OWNABLE_ROLES.includes(row.role)) throw new ForbiddenError(`a ${row.role} cannot own records`);
  return row;
}
