import type { Prisma, PrismaClient } from "@prisma/client";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

// WHAT THIS REPLACES: the old visibility.ts, whose member-isolation branch was
// `if (shareAllLeads || role === COMPANY_ADMIN) return { companyId }` with `shareAllLeads ??
// true` — i.e. share-everything by default, configurable per company, and company-wide rather
// than team-wide. Company.shareAllLeads is gone and so is that branch. The rules here are
// absolute and not configurable:
//
//   SUPER_ADMIN    every team in the company it is scoped to
//   COMPANY_ADMIN  its own team, all owners ("Team Admin")
//   MEMBER         LEADS: its own rows only — ALWAYS, with no setting that widens it
//                  ACCOUNTS: the ones it MANAGES **or** is ASSIGNED to (see accountScopeWhere)
//   ONBOARDING     no CRM at all; ONLY the accounts it is ASSIGNED to
//   PARTNER_VIEWER no CRM at all; exactly one Account
//
// ACCESS TO A BUILDING NOW COMES FROM ASSIGNMENT, not only from ownership. The product owner's
// words: "every sales manager and assigned onboarding member should only see their buildings data.
// Several team members can be assigned to one building." So the ACCOUNT scope is a MEMBERSHIP test
// (manager OR an AccountAssignment row), while the LEAD scope is unchanged — a lead still belongs
// to exactly the person selling it, and there is no such thing as a lead assignment.
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

// `companyId` IS ALWAYS A TOP-LEVEL KEY, in every branch, and must stay one: a long list of
// callers read `scope.companyId` straight off the returned object to scope a sibling table
// (service-fees.ts, settlements.ts, accounts.ts getAccount). Moving it inside the AND would
// silently hand those callers `undefined` — which in a Prisma WHERE is no filter at all.
//
// `AND` carries the MEMBERSHIP test, which cannot be expressed as a flat key because it is an OR
// (manager OR assigned). See the composition rule on accountScopeWhere before touching this.
export type AccountScope = {
  companyId: string;
  teamId?: string;
  id?: string;
  AND?: Prisma.AccountWhereInput[];
};

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
  // AND NEITHER DOES ONBOARDING. This ONE throw is what keeps activation staff out of the CRM
  // board, the dashboard, the reports and /work — every one of those resolves its scope through
  // this function (getDashboardStats, getReport, getMyWork, leads.ts, stages.ts). Onboarding staff
  // work a post-contract checklist on buildings already won; the pipeline of who we are still
  // selling to is not theirs, and it is not scoped by anything they are assigned to either.
  //
  // Stated as its own branch rather than left to the fail-closed throw at the bottom so the reason
  // is visible and so the error message says what it means.
  if (user.role === "ONBOARDING") throw new ForbiddenError("onboarding staff cannot access the CRM");
  const companyId = requireCompany(user);
  if (user.role === "SUPER_ADMIN") return { companyId };
  const teamId = requireTeam(user);
  if (user.role === "COMPANY_ADMIN") return { companyId, teamId };
  if (user.role === "MEMBER") return { companyId, teamId, ownerId: user.id };
  // Unreachable today. Kept so that adding a Role without revisiting this file is a 403 rather
  // than an unscoped read.
  throw new ForbiddenError(`role ${user.role} has no lead scope`);
}

// THE WHERE every tenant-scoped Account read must start from. A MEMBERSHIP TEST, not an ownership
// one.
//
//   PARTNER_VIEWER  exactly one account, by id                                      (unchanged)
//   SUPER_ADMIN     the whole company it was given a context for                    (unchanged)
//   COMPANY_ADMIN   its own team                                                     (unchanged)
//   MEMBER          accounts it MANAGES **or** is ASSIGNED to, inside its own team   (RELAXED)
//   ONBOARDING      accounts it is ASSIGNED to, company-wide, NO team key            (new)
//
// THE MEMBER RELAXATION IS DELIBERATE. It used to be `accountManagerId: user.id` — own rows only.
// Several sales managers now legitimately work one building, so the manager column alone no longer
// describes who may see it. The team key stays, so a member still cannot be assigned into another
// team's book and read it; the assignment only widens them WITHIN their own team.
//
// ONBOARDING CARRIES NO TEAM KEY, and that is not an omission. Activation staff have teamId null
// (like a SUPER_ADMIN) because they serve every team's buildings, so `requireTeam` would throw for
// all of them. Dropping a key is normally the exact shape of a leak — but here the assignment test
// in `AND` is the ONLY thing that selects rows at all, and it is an inclusion list of rows somebody
// with manage_account_assignments explicitly granted. An ONBOARDING user with no assignments sees
// nothing, which is the fail-closed direction.
//
// ===================== THE COMPOSITION RULE — READ THIS BEFORE ADDING A CALLER ================
//
// The membership test lives under `AND`. So:
//
//     { ...scope, AND: extraFilters }    // ***FAILS OPEN*** — the spread copies `AND`, then the
//                                        // literal's own `AND` REPLACES it, and the membership
//                                        // test is gone. The query does not return fewer rows,
//                                        // it returns the WHOLE TEAM (or, for ONBOARDING, the
//                                        // whole company).
//     { ...scope, OR: extraFilters }     // same class of bug for any future OR-shaped scope.
//
// Do one of these instead, both of which are safe:
//
//     { AND: [scope, ...extraFilters] }  // nest the scope; Prisma ANDs the nested AND fine
//     { account: scope }                 // use it as a RELATION filter (dashboard.ts, work.ts)
//
// A spread that adds only SCALAR keys the scope does not use (`{ id, ...scope }`,
// `{ ...scope, status: "ACTIVE" }`) is still safe, because nothing is being overwritten — but it is
// one careless edit away from not being, so prefer the AND form in new code.
// =============================================================================================
export function accountScopeWhere(user: SessionUser): AccountScope {
  const companyId = requireCompany(user);
  // Not a throw: a partner login's whole purpose is its one account. The id filter is what
  // confines it, and it is always present.
  if (user.role === "PARTNER_VIEWER") return { companyId, id: user.accountId ?? NO_ACCESS };
  if (user.role === "SUPER_ADMIN") return { companyId };
  // Before requireTeam: ONBOARDING has no team, so asking for one would throw for every one of
  // them. Company + assignment is the whole filter.
  if (user.role === "ONBOARDING") {
    return { companyId, AND: [{ assignments: { some: { userId: user.id } } }] };
  }
  const teamId = requireTeam(user);
  if (user.role === "COMPANY_ADMIN") return { companyId, teamId };
  if (user.role === "MEMBER") {
    return {
      companyId,
      teamId,
      // Wrapped in AND rather than written as a bare top-level `OR` key for exactly the reason the
      // composition rule above gives: a top-level `OR` is the key most likely to be clobbered by a
      // caller adding its own `OR` through a spread, and clobbering this one returns the member
      // their whole team's accounts.
      AND: [
        {
          OR: [
            { accountManagerId: user.id },
            { assignments: { some: { userId: user.id } } },
          ],
        },
      ],
    };
  }
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
  // NEITHER CAN ONBOARDING. Activation staff are not in anybody's sales book: they have no team for
  // a row to belong to (teamId null), they cannot reach the CRM at all (leadScopeWhere above), and
  // their account access comes from assignment rather than from owning anything. An explicit throw
  // here, plus OWNABLE_ROLES below refusing to LOAD one as a candidate, means the role can neither
  // assign nor be assigned.
  if (user.role === "ONBOARDING") throw new ForbiddenError("onboarding staff cannot own records");

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

// One primary-key lookup, three fail-closed checks. Notably this is what stops a SUPER_ADMIN, an
// ONBOARDING user or a PARTNER_VIEWER from ever becoming an owner: none of those roles is in
// OWNABLE_ROLES, so none can be named — a super admin and an onboarding user have no team for the
// row to belong to, and a partner login must never appear in a team's book. (OWNABLE_ROLES is
// unchanged by the ONBOARDING work: it was already an allowlist of two, so the new role is excluded
// by construction. The pickers are consistent — users.ts TEAM_ROLES is the same pair.)
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
