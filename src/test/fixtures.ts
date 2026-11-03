// Shared builders for the org + Teams model.
//
// WHY THIS EXISTS: every Lead and Account now needs a `teamId` and a `buildingKey`, and every
// SessionUser needs a `teamId`. Roughly 62 raw lead/account creates across ~29 test files would
// otherwise each have to invent those values by hand. Going through these helpers keeps that
// churn mechanical and keeps the team wiring correct in one place: a user, their team and their
// company always agree, and building keys are unique per company unless a test asks otherwise.
//
// Deliberately thin: these build rows, they do not call domain services. A test that wants to
// exercise createLead()/convertLeadToAccount() should still call those.
import type { Role, Team, User } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { testPrisma } from "./db";

// Monotonic suffix so repeated calls inside one test never collide on Company.slug,
// User.email or (companyId, buildingKey). Reset per process, not per test — uniqueness is all
// that matters, not the actual numbers.
let seq = 0;
export function uniq(prefix = "x"): string {
  seq += 1;
  return `${prefix}${seq}`;
}

// The same normalization the migration's backfill applies and the app applies on every write:
// NFKC, trim, collapse internal whitespace, lowercase, then strip U+0307 (COMBINING DOT ABOVE).
//
// The U+0307 strip is what makes Azerbaijani input agree across the two layers:
// `"İ".toLowerCase()` in JS yields "i" + U+0307, whereas Postgres `lower()` yields a bare "i".
// Without the strip the app would compute a key the database's own backfill could never produce.
export function buildingKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase().replace(/̇/g, "");
}

// A LIVE partner link, as a spread into an account's create data.
//
// Account.externalPartnerKey on its own no longer means the account can read anything: it is half
// of a two-state machine, and a row with a key but no partnerLinkConfirmedAt is a PENDING link that
// grants nothing (security review finding F1 — see src/lib/partner-api/credentials.ts). A test that
// wants a working partner account must therefore say which state it means, and most mean this one.
//
// Pending is the other state, written as a bare `externalPartnerKey` with no stamp; it is spelled
// out longhand at the few sites that test the gate itself, because there the state IS the subject.
export function confirmedPartnerLink(partnerName: string) {
  return { externalPartnerKey: partnerName, partnerLinkConfirmedAt: new Date() };
}

export async function makeCompany(opts: { name?: string; slug?: string } = {}) {
  const slug = opts.slug ?? uniq("co-");
  return testPrisma.company.create({
    data: { name: opts.name ?? `Company ${slug}`, slug },
  });
}

// A team, creating its company if one was not supplied.
export async function makeTeam(
  opts: { companyId?: string; name?: string } = {},
): Promise<Team> {
  const companyId = opts.companyId ?? (await makeCompany()).id;
  return testPrisma.team.create({
    // Team has @@unique([companyId, name]), so default to a unique name rather than a fixed
    // "Sales Team 1" that would collide on a second team in the same company.
    data: { companyId, name: opts.name ?? uniq("Team ") },
  });
}

// A user placed on `team`, in that team's company.
//
// COMPANY_ADMIN ("Team Admin" in the UI) and MEMBER get the team. SUPER_ADMIN and PARTNER_VIEWER
// are forced to teamId null to match the real model — a SUPER_ADMIN sees every team and has no
// company either, and a PARTNER_VIEWER is scoped to one Account via accountId. Pass an explicit
// `teamId` override only to construct a deliberately invalid row.
export async function makeUser(
  role: Role,
  team?: Team,
  overrides: { email?: string; name?: string; accountId?: string | null; teamId?: string | null } = {},
): Promise<User> {
  const scoped = role === "COMPANY_ADMIN" || role === "MEMBER";
  const teamId = overrides.teamId !== undefined ? overrides.teamId : scoped ? (team?.id ?? null) : null;
  const companyId = role === "SUPER_ADMIN" ? null : (team?.companyId ?? null);
  return testPrisma.user.create({
    data: {
      companyId,
      teamId,
      email: overrides.email ?? `${uniq("u-")}@test.local`,
      passwordHash: "x",
      name: overrides.name ?? "Test User",
      role,
      accountId: overrides.accountId ?? null,
    },
  });
}

// The session shape the app's guards receive, derived from a persisted user so the two can never
// drift apart in a test.
export function su(user: Pick<User, "id" | "companyId" | "teamId" | "role" | "accountId">): SessionUser {
  return {
    id: user.id,
    companyId: user.companyId,
    teamId: user.teamId,
    role: user.role,
    accountId: user.accountId,
  };
}

// Convenience: a company, a team, a team admin and a member, all consistently wired. Most tests
// want exactly this.
export async function makeTeamWithUsers(opts: { companyId?: string; name?: string } = {}) {
  const team = await makeTeam(opts);
  const admin = await makeUser("COMPANY_ADMIN", team);
  const member = await makeUser("MEMBER", team);
  return { team, companyId: team.companyId, admin, member, suAdmin: su(admin), suMember: su(member) };
}
