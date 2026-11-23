import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { seedOrgTemplate } from "../../src/lib/tenant/team-template";
import { MIN_PASSWORD, createSuperAdmin, promoteSuperAdmin } from "./super-admin";
import { describeTarget } from "./reset-data";

// TAKE A FRESHLY-MIGRATED, EMPTY DATABASE TO THE MINIMUM STATE THAT ALLOWS A FIRST LOGIN.
//
//   BOOTSTRAP_COMPANY_NAME="Qonshu" BOOTSTRAP_COMPANY_SLUG="qonshu" \
//   SUPER_ADMIN_EMAIL=owner@example.com SUPER_ADMIN_PASSWORD='...' npm run bootstrap
//
// WHY IT EXISTS: after `prisma migrate deploy` on a brand-new database the schema is there and
// every table is empty, and NOTHING in the repo can get you from there to a login:
//
//   * super-admin.ts --promote needs an existing User row; there are none.
//   * super-admin.ts --create calls resolveCompanyId, which throws "no company exists yet" at
//     zero companies and cannot create one.
//   * the org-level template (Stage / AccountFieldDef rows with teamId = null) has to exist or
//     cloneTemplateToTeam produces a team with zero stages, which per team-template.ts "cannot
//     hold a lead" — so the owner could log in and make a team but never enter a lead.
//   * prisma/seed.ts does cover all three, but it also creates demo teams, leads, accounts and
//     shared-password demo logins, which is precisely what an owner entering real data by hand
//     does not want in their production database.
//
// WHAT IT CREATES, exhaustively: ONE Company, the org template rows, ONE SUPER_ADMIN User. No
// teams, no leads, no accounts, no other users — those are the owner's job in the UI.
//
// WHY THE CREDENTIALS COME FROM THE ENVIRONMENT ONLY: same reasoning as super-admin.ts — a
// password passed as an argument lands in the shell history, in `ps` output and in CI logs. There
// is deliberately no --email/--password flag to find.
//
// WHY IT REFUSES ON A NON-EMPTY DATABASE: this script's safe outcome on a live system is
// *nothing*. Any Team, Lead or Account row, or more than one Company, means the database is in
// use, and a half-applied bootstrap over real tenant data is unrecoverable. It prints what it
// found and exits non-zero instead.
//
// The writes are one interactive transaction, so a partial failure leaves the database exactly as
// it was and the script can simply be re-run. Every step is idempotent: a second run reports what
// already exists and writes nothing.

const DEFAULT_COMPANY_NAME = "Qonshu";
const DEFAULT_COMPANY_SLUG = "qonshu";

// Mirrors the slug column's practical use: it appears in URLs and is matched exactly by
// resolveCompanyId and prisma/seed.ts, so a slug with spaces or capitals is a silent mismatch
// later rather than an error now.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type TenantCensus = {
  companies: number;
  teams: number;
  leads: number;
  accounts: number;
  users: number;
};

type CensusDb = Pick<PrismaClient, "company" | "team" | "lead" | "account" | "user">;

// Read before anything is written. Counted rather than "findFirst"ed so the refusal message can
// say how much data it is protecting.
export async function censusTenantData(db: CensusDb): Promise<TenantCensus> {
  const [companies, teams, leads, accounts, users] = await Promise.all([
    db.company.count(),
    db.team.count(),
    db.lead.count(),
    db.account.count(),
    db.user.count(),
  ]);
  return { companies, teams, leads, accounts, users };
}

// The refusal rule, as a pure function so it is testable and so the reason is a value rather than
// a thrown string. Users are NOT a blocker on their own: a run that created the owner and then
// failed must stay re-runnable, and the owner is the one row this script is allowed to find.
export function refusalReason(c: TenantCensus): string | null {
  const found: string[] = [];
  if (c.teams > 0) found.push(`${c.teams} team(s)`);
  if (c.leads > 0) found.push(`${c.leads} lead(s)`);
  if (c.accounts > 0) found.push(`${c.accounts} account(s)`);
  if (c.companies > 1) found.push(`${c.companies} companies`);
  if (found.length === 0) return null;
  return `this database already holds tenant data: ${found.join(", ")}`;
}

export type BootstrapResult = {
  company: { id: string; name: string; slug: string; created: boolean };
  template: { stages: number; fieldDefs: number };
  owner: { id: string; email: string; created: boolean; repaired: boolean };
};

export type BootstrapArgs = {
  companyName: string;
  companySlug: string;
  email: string;
  password: string;
  name?: string;
};

// The one write path. Company first (createSuperAdmin's resolveCompanyId needs it to exist),
// then the org template, then the owner.
export async function bootstrap(prisma: PrismaClient, args: BootstrapArgs): Promise<BootstrapResult> {
  return prisma.$transaction(async (txRaw) => {
    const tx = txRaw as unknown as PrismaClient;

    // Reuse an existing company with this slug; never create a second one. If exactly one company
    // exists under a DIFFERENT slug we stop rather than guess: creating a second org container
    // here would attach the owner to an empty company beside the real one, and the
    // `requireCompany` failure that follows looks nothing like its cause.
    let company = await tx.company.findUnique({ where: { slug: args.companySlug } });
    let companyCreated = false;
    if (!company) {
      const other = await tx.company.findFirst({ select: { slug: true, name: true } });
      if (other) {
        throw new Error(
          `a company already exists with slug "${other.slug}" (${other.name}), not "${args.companySlug}" — ` +
            `set BOOTSTRAP_COMPANY_SLUG=${other.slug} to bootstrap into it`,
        );
      }
      company = await tx.company.create({ data: { name: args.companyName, slug: args.companySlug } });
      companyCreated = true;
    }

    // Stage / AccountFieldDef rows with teamId = null. Idempotent per kind; see team-template.ts.
    const template = await seedOrgTemplate(tx, company.id);

    // Returns created:false, untouched, when this email is already the super admin.
    const created = await createSuperAdmin(tx, {
      email: args.email,
      password: args.password,
      name: args.name,
      companySlug: args.companySlug,
    });

    // createSuperAdmin's already-provisioned branch does not assert the row's SHAPE, and that
    // shape is what decides whether the owner can use the app at all: the authenticated layout
    // redirects to /login when companyId is null, and scope.ts branches on role before teamId.
    // promoteSuperAdmin is the existing, idempotent fix for exactly that, so run it either way —
    // it reports changed:false on the row createSuperAdmin just wrote.
    const promoted = await promoteSuperAdmin(tx, created.email, { companySlug: args.companySlug });

    return {
      company: { id: company.id, name: company.name, slug: company.slug, created: companyCreated },
      template,
      owner: { id: promoted.id, email: promoted.email, created: created.created, repaired: promoted.changed },
    };
  });
}

const USAGE = `Usage:
  npm run bootstrap

Environment:
  SUPER_ADMIN_EMAIL        required - the owner's login
  SUPER_ADMIN_PASSWORD     required - at least ${MIN_PASSWORD} characters (never passed as an argument)
  SUPER_ADMIN_NAME         optional - display name (default "Owner")
  BOOTSTRAP_COMPANY_NAME   optional - org name  (default "${DEFAULT_COMPANY_NAME}")
  BOOTSTRAP_COMPANY_SLUG   optional - org slug  (default "${DEFAULT_COMPANY_SLUG}")

Creates exactly one Company, the org-level Stage/AccountFieldDef template, and one SUPER_ADMIN
user. Refuses to run if the database already holds teams, leads, accounts or several companies.`;

function createPrismaClient(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as Prisma.PrismaClientOptions);
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const unknown = argv.filter((a) => !["--help", "-h"].includes(a));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}\n${USAGE}`);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");

  const companyName = process.env.BOOTSTRAP_COMPANY_NAME?.trim() || DEFAULT_COMPANY_NAME;
  const companySlug = process.env.BOOTSTRAP_COMPANY_SLUG?.trim() || DEFAULT_COMPANY_SLUG;
  const email = process.env.SUPER_ADMIN_EMAIL?.trim() ?? "";
  const password = process.env.SUPER_ADMIN_PASSWORD ?? "";
  const name = process.env.SUPER_ADMIN_NAME;

  // Printed FIRST, before any read or write, so the log opens with WHICH database this was.
  // describeTarget never reads the password out of the URL, and the password is never logged.
  console.log(`target:  ${describeTarget(url)}`);
  console.log(`company: name="${companyName}" slug="${companySlug}"`);
  console.log(`owner:   ${email || "(SUPER_ADMIN_EMAIL not set)"}`);
  console.log("");

  // Validated before connecting, so a missing variable costs nothing and says so plainly.
  if (!email) throw new Error(`SUPER_ADMIN_EMAIL is required\n${USAGE}`);
  if (password.length < MIN_PASSWORD) {
    throw new Error(
      `SUPER_ADMIN_PASSWORD is required and must be at least ${MIN_PASSWORD} characters\n${USAGE}`,
    );
  }
  if (!SLUG_RE.test(companySlug)) {
    throw new Error(
      `BOOTSTRAP_COMPANY_SLUG "${companySlug}" must be lower-case letters, digits and hyphens`,
    );
  }

  const prisma = createPrismaClient(url);
  try {
    const census = await censusTenantData(prisma);
    const refusal = refusalReason(census);
    if (refusal) {
      console.error(`REFUSING TO RUN - ${refusal}`);
      console.error(
        `  companies=${census.companies} teams=${census.teams} leads=${census.leads} ` +
          `accounts=${census.accounts} users=${census.users}`,
      );
      console.error("");
      console.error("bootstrap.ts is only for an empty, freshly-migrated database. Nothing was written.");
      console.error("To provision an owner on a database that is already in use, use instead:");
      console.error("  npx tsx prisma/scripts/super-admin.ts --promote <email>");
      process.exitCode = 1;
      return;
    }

    const r = await bootstrap(prisma, { companyName, companySlug, email, password, name });

    console.log(
      r.company.created
        ? `created Company "${r.company.name}" (slug ${r.company.slug}, id ${r.company.id})`
        : `Company "${r.company.name}" (slug ${r.company.slug}, id ${r.company.id}) already existed - unchanged`,
    );
    console.log(
      r.template.stages || r.template.fieldDefs
        ? `created org template: ${r.template.stages} stage(s), ${r.template.fieldDefs} field definition(s) (teamId = null)`
        : "org template already present - unchanged",
    );
    console.log(
      r.owner.created
        ? `created SUPER_ADMIN ${r.owner.email} (id ${r.owner.id}, company ${r.company.id}, no team, no account)`
        : r.owner.repaired
          ? `SUPER_ADMIN ${r.owner.email} already existed (id ${r.owner.id}) - repaired role/company/team/status`
          : `SUPER_ADMIN ${r.owner.email} already provisioned (id ${r.owner.id}) - unchanged`,
    );
    console.log("");
    console.log("no teams, leads, accounts or other users were created - add those in the UI.");
    console.log(`log in at /login as: ${r.owner.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly, never on import (mirrors super-admin.ts / reset-data.ts).
if (process.argv[1] && /bootstrap\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
