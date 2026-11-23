import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../../src/lib/auth/password";

// PROVISION THE ONE OWNER ACCOUNT. Run against a database, never reachable over HTTP:
//
//   npx tsx prisma/scripts/super-admin.ts --promote ali@example.com
//   SUPER_ADMIN_EMAIL=... SUPER_ADMIN_PASSWORD=... npx tsx prisma/scripts/super-admin.ts --create
//
// WHY IT EXISTS: production has no SUPER_ADMIN at all — its only user is a COMPANY_ADMIN — and in
// the teams model a COMPANY_ADMIN is a TEAM admin: it cannot create teams, cannot create other
// team admins, and sees only its own team's book. So there is currently nobody who can set the org
// up, and no authenticated route that can mint the role (createUser in src/lib/tenant/users.ts
// refuses role SUPER_ADMIN by design). `--promote` is the one-line fix for that database.
//
// WHY --create TAKES NO ARGUMENTS: a password passed on the command line lands in the shell
// history, in `ps` output, and in CI logs; a password written into a migration or a seed is
// committed forever. The credentials are therefore read ONLY from the environment, and --create
// refuses outright once any super admin exists, so it cannot be used to quietly add a second
// owner to a live system.
//
// Both subcommands are idempotent: re-running --promote on an already-promoted user changes
// nothing, and re-running --create with the same SUPER_ADMIN_EMAIL reports "already provisioned"
// and succeeds without touching the row.

// Exported so prisma/scripts/bootstrap.ts can enforce the SAME minimum instead of keeping a
// second copy of the number.
export const MIN_PASSWORD = 8; // matches the app's own policy (api/users CreateBody)

type Db = PrismaClient;

export type PromoteResult = { id: string; email: string; companyId: string; changed: boolean };

// Make an existing login the owner: role SUPER_ADMIN, no team, no account, attached to the org.
//
// `teamId` MUST be cleared. A SUPER_ADMIN carrying a team is not a wider version of a team admin,
// it is an ambiguous row: scope.ts branches on role first, so the team would be silently ignored
// everywhere except the places that read user.teamId directly. Same for accountId, which would
// otherwise pin the owner to one building.
export async function promoteSuperAdmin(
  db: Db,
  email: string,
  opts: { companySlug?: string } = {},
): Promise<PromoteResult> {
  // Exact match first, then case-insensitive: the email is typed by hand into a shell for a
  // one-shot production fix, and "no user with that email" because of a capital letter would send
  // the operator looking for the wrong problem. Still refuses if the looser match is ambiguous.
  const trimmed = email.trim();
  let user = await db.user.findUnique({ where: { email: trimmed } });
  if (!user) {
    const loose = await db.user.findMany({ where: { email: { equals: trimmed, mode: "insensitive" } }, take: 2 });
    if (loose.length > 1) throw new Error(`${trimmed} matches more than one login by case — use the exact email`);
    user = loose[0] ?? null;
  }
  if (!user) throw new Error(`no user with email ${trimmed}`);

  const companyId = await resolveCompanyId(db, user.companyId, opts.companySlug);
  const changed =
    user.role !== "SUPER_ADMIN" ||
    user.teamId !== null ||
    user.accountId !== null ||
    user.companyId !== companyId ||
    user.status !== "ACTIVE";

  if (changed) {
    await db.user.update({
      where: { id: user.id },
      data: { role: "SUPER_ADMIN", teamId: null, accountId: null, companyId, status: "ACTIVE" },
    });
  }
  return { id: user.id, email: user.email, companyId, changed };
}

export type CreateResult = { id: string; email: string; companyId: string; created: boolean };

// Create the owner from environment credentials. Refuses if ANY super admin already exists —
// except when that super admin is this very email, which makes a repeated run a no-op instead of
// an error.
export async function createSuperAdmin(
  db: Db,
  args: { email: string; password: string; name?: string; companySlug?: string },
): Promise<CreateResult> {
  if (!args.email) throw new Error("SUPER_ADMIN_EMAIL is required");
  if (!args.password || args.password.length < MIN_PASSWORD) {
    throw new Error(`SUPER_ADMIN_PASSWORD is required and must be at least ${MIN_PASSWORD} characters`);
  }

  const existing = await db.user.findFirst({ where: { role: "SUPER_ADMIN" }, select: { id: true, email: true } });
  if (existing) {
    if (existing.email === args.email) {
      const row = await db.user.findUniqueOrThrow({ where: { id: existing.id }, select: { companyId: true } });
      return { id: existing.id, email: existing.email, companyId: row.companyId ?? "", created: false };
    }
    // Named, because the operator needs to know WHICH account already owns the org before
    // deciding what to do; the email is not a secret and this output never leaves the server.
    throw new Error(`a super admin already exists (${existing.email}) — use --promote to move the role`);
  }

  const byEmail = await db.user.findUnique({ where: { email: args.email }, select: { id: true } });
  if (byEmail) throw new Error(`${args.email} already exists — use --promote ${args.email} instead`);

  const companyId = await resolveCompanyId(db, null, args.companySlug);
  const passwordHash = await hashPassword(args.password);
  const created = await db.user.create({
    data: {
      companyId,
      teamId: null,
      email: args.email,
      name: args.name?.trim() || "Owner",
      passwordHash,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
  });
  return { id: created.id, email: created.email, companyId, created: true };
}

// The org the owner belongs to. Keeps an existing companyId, else takes the named slug, else THE
// single company. Ambiguity throws: picking one of several companies for the operator would attach
// the owner to the wrong org with no way to notice.
async function resolveCompanyId(
  db: Db,
  current: string | null,
  companySlug?: string,
): Promise<string> {
  if (companySlug) {
    const named = await db.company.findUnique({ where: { slug: companySlug }, select: { id: true } });
    if (!named) throw new Error(`no company with slug ${companySlug}`);
    return named.id;
  }
  if (current) return current;
  const companies = await db.company.findMany({ select: { id: true, slug: true }, take: 2 });
  if (companies.length === 0) throw new Error("no company exists yet — create one before provisioning the owner");
  if (companies.length > 1) {
    throw new Error("more than one company exists — set SUPER_ADMIN_COMPANY_SLUG to pick one");
  }
  return companies[0].id;
}

const USAGE = `Usage:
  npx tsx prisma/scripts/super-admin.ts --promote <email>
  npx tsx prisma/scripts/super-admin.ts --create        (reads SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD,
                                                         optional SUPER_ADMIN_NAME, SUPER_ADMIN_COMPANY_SLUG)`;

// The client is built HERE rather than at module scope so this file can be imported by its test
// (which supplies its own test client) without needing DATABASE_URL.
function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

async function main(argv: string[]): Promise<void> {
  const companySlug = process.env.SUPER_ADMIN_COMPANY_SLUG;
  const db = createPrismaClient();
  try {
    if (argv[0] === "--promote") {
      const email = argv[1];
      if (!email) throw new Error(`--promote needs an email\n${USAGE}`);
      const r = await promoteSuperAdmin(db, email, { companySlug });
      console.log(
        r.changed
          ? `promoted ${r.email} to SUPER_ADMIN (id ${r.id}, company ${r.companyId}, team cleared)`
          : `${r.email} is already the SUPER_ADMIN (id ${r.id}) — nothing to do`,
      );
      return;
    }
    if (argv[0] === "--create") {
      // Credentials come from the environment ONLY. Nothing read here is ever logged.
      const r = await createSuperAdmin(db, {
        email: process.env.SUPER_ADMIN_EMAIL ?? "",
        password: process.env.SUPER_ADMIN_PASSWORD ?? "",
        name: process.env.SUPER_ADMIN_NAME,
        companySlug,
      });
      console.log(
        r.created
          ? `created SUPER_ADMIN ${r.email} (id ${r.id}, company ${r.companyId})`
          : `SUPER_ADMIN ${r.email} already provisioned (id ${r.id}) — nothing to do`,
      );
      return;
    }
    throw new Error(USAGE);
  } finally {
    await db.$disconnect();
  }
}

// Only run when executed directly (`tsx prisma/scripts/super-admin.ts …`), never on import.
if (process.argv[1] && /super-admin\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
