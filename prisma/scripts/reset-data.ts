import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { seedOrgTemplate } from "../../src/lib/tenant/team-template";

// EMPTY THE DATABASE OF ALL BUSINESS DATA, keeping the schema, the migration history and the
// owner's login, so the org can be re-entered from scratch.
//
//   npx tsx prisma/scripts/reset-data.ts                       # DRY RUN (default): counts only
//   RESET_I_UNDERSTAND=yes npx tsx prisma/scripts/reset-data.ts --confirm
//
// WHY A DRY RUN IS THE DEFAULT: the only correct outcome of running this file by accident is
// nothing. `--confirm` alone is not enough either — a flag is one tab-completion away in a shell
// where the previous command was the real thing — so the RESET_I_UNDERSTAND env var has to be set
// in the same invocation, which is not something a shell offers to repeat for you.
//
// WHAT IS KEPT, and why each one is not negotiable:
//
//   * Every User with role SUPER_ADMIN (the identification used by
//     prisma/scripts/super-admin.ts). Credentials live on the row itself —
//     `User.passwordHash` — so preserving the row preserves the login. There is NO separate
//     account/credential table and NO Session model in this schema: auth is next-auth with a JWT
//     strategy, so sessions are cookies, not rows, and "drop the sessions" happens for free (an
//     existing cookie keeps working because src/lib/auth/session.ts re-reads the user row on
//     every call — and the row is still there).
//
//   * The Company row(s) those super admins point at. THIS IS THE ONE PLACE THE KEEP-LIST GOES
//     WIDER THAN "just the user", and it is a real constraint, not a convenience:
//       - Login itself does not need it (src/lib/auth/authorize.ts tolerates a null companyId),
//         but every tenant read does: requireCompany in src/lib/tenant/scope.ts fails closed on a
//         null companyId, so an owner whose company was deleted could sign in and then hit a
//         tenant-context error on leads, accounts, teams — every page.
//       - It is also unrecoverable from the CLI: resolveCompanyId in super-admin.ts throws
//         "no company exists yet" when there are zero companies, so `--promote` cannot repair it.
//     Keeping it does NOT keep a tenant. In this data model Company is the single ORG container
//     (Qonshu) and TEAM is the isolation boundary — see the comment on `model Team` in
//     schema.prisma: "Teams are the isolation boundary that Company used to be." Every Team is
//     deleted, and the surviving Company row holds nothing but its name and slug.
//     Companies that no super admin belongs to are deleted like anything else.
//
//   * The ORG-LEVEL TEMPLATE rows (Stage and AccountFieldDef with `teamId = null`) are deleted
//     with everything else and then REBUILT from code by seedOrgTemplate, inside the same
//     transaction. This is the one write this script performs beyond deletes, and it is required
//     for the stated goal: cloneTemplateToTeam copies the template when a team is created, and
//     an empty template yields a team with zero stages, which per team-template.ts "cannot hold
//     a lead" — so without this the owner could log in and create a team but never enter a lead,
//     with no CLI path to fix it (seedOrgTemplate is otherwise only reachable via the demo seed,
//     which would also re-create demo leads). Pass --no-template to skip the rebuild.
//
// Everything is one `prisma.$transaction`, so a failure anywhere leaves the database untouched.

const DRY_RUN_NOTE = "DRY RUN — nothing was written";

// Every model in schema.prisma that holds business data, in FK-DEPENDENCY ORDER: children first.
// Explicit per-model deletes rather than TRUNCATE ... CASCADE, because CASCADE from Company would
// take the preserved super admins' company with it and could not honour a keep-list at all.
//
// The order matters for the RESTRICT edges, which Postgres will refuse rather than cascade:
//   Lead.stageId -> Stage, Lead.teamId -> Team, Account.teamId -> Team,
//   Account.accountManagerId -> User, Lead.ownerId -> User.
// Hence: lead/account children, then Lead and Account, then Stage/AccountFieldDef, then User,
// then Team, then Company.
const DELETION_ORDER = [
  // --- children of Account ---
  "accountFieldValue", // custom field VALUES (also child of AccountFieldDef)
  "serviceFee", // monthly service fees
  "settlementEntry", // cash collected / transferred registry
  "platformInstallSnapshot", // manually-entered iOS/Android install counts
  "accountAttachment", // account file attachments (DB rows; see disk note below)
  "accountAsk", // account asks / requests
  "accountTask", // account tasks
  "accountActivity", // account notes, calls, meetings, emails
  // Partner-link audit trail. Deliberately attached to nothing that cascades (see its header in
  // schema.prisma), so it is ONLY removed by naming it here — and it must be, because it holds
  // tenant data: which account was linked to which external complex, and by whom.
  "partnerLinkAudit",
  // --- children of Lead ---
  "attachment", // lead file attachments
  "task", // lead tasks
  "activity", // lead notes, calls, meetings, emails, stage changes
  // --- the two books ---
  "lead", // includes contact name/email/phone, which are columns on Lead, not a table
  "account", // includes externalPartnerKey + the encrypted partner API key
  // --- per-team configuration ---
  "stage", // team pipelines AND the org template rows (teamId = null)
  "accountFieldDef", // team field definitions AND the org template rows (teamId = null)
  "invitation", // pending/accepted/revoked invites
  // --- principals, then the containers ---
  "user", // every user EXCEPT role SUPER_ADMIN
  "team", // every team
  "company", // every company EXCEPT one a preserved super admin belongs to
] as const;

type ModelName = (typeof DELETION_ORDER)[number];

// A narrow structural view of the delegates this script touches, so `db[model]` type-checks for
// every name in DELETION_ORDER without resorting to `any`. `where` is intentionally loose: the
// filters below are per-model and already validated by the delegate calls that build them.
type CountableDelegate = {
  count(args?: { where?: unknown }): Promise<number>;
  deleteMany(args?: { where?: unknown }): Promise<{ count: number }>;
};
type ResetDb = Record<ModelName, CountableDelegate> & {
  user: {
    findMany(args: {
      where: { role: "SUPER_ADMIN" };
      select: { id: true; email: true; companyId: true };
    }): Promise<{ id: string; email: string; companyId: string | null }[]>;
    updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
  } & CountableDelegate;
};

export type KeepList = { userIds: string[]; companyIds: string[]; emails: string[] };

// Resolve the keep-list from the database rather than from arguments: the operator cannot mistype
// their way into deleting the owner, and a database with two super admins keeps both.
export async function resolveKeepList(db: ResetDb): Promise<KeepList> {
  const supers = await db.user.findMany({
    where: { role: "SUPER_ADMIN" },
    select: { id: true, email: true, companyId: true },
  });
  const companyIds = [...new Set(supers.map((u) => u.companyId).filter((id): id is string => Boolean(id)))];
  return {
    userIds: supers.map((u) => u.id),
    companyIds,
    emails: supers.map((u) => u.email),
  };
}

// The per-model filter. Only `user` and `company` are ever narrowed; every other model is
// unconditional, which is what makes "did I forget a tenant row?" answerable by reading
// DELETION_ORDER alone.
function whereFor(model: ModelName, keep: KeepList): { where?: unknown } {
  if (model === "user") {
    return keep.userIds.length ? { where: { id: { notIn: keep.userIds } } } : {};
  }
  if (model === "company") {
    return keep.companyIds.length ? { where: { id: { notIn: keep.companyIds } } } : {};
  }
  return {};
}

export async function countTargets(db: ResetDb, keep: KeepList): Promise<Map<ModelName, number>> {
  const out = new Map<ModelName, number>();
  for (const model of DELETION_ORDER) {
    out.set(model, await db[model].count(whereFor(model, keep)));
  }
  return out;
}

// Surviving rows per model, for the after-report. Same list, no keep-filter: this is the answer to
// "what is actually left in the database", which is the number worth printing after a wipe.
export async function countRemaining(db: ResetDb): Promise<Map<ModelName, number>> {
  const out = new Map<ModelName, number>();
  for (const model of DELETION_ORDER) {
    out.set(model, await db[model].count());
  }
  return out;
}

function renderTable(rows: [string, number][], header: [string, string]): string {
  const nameWidth = Math.max(header[0].length, ...rows.map(([n]) => n.length));
  const numWidth = Math.max(header[1].length, ...rows.map(([, c]) => String(c).length));
  const line = `  ${"-".repeat(nameWidth)}  ${"-".repeat(numWidth)}`;
  const body = rows.map(([n, c]) => `  ${n.padEnd(nameWidth)}  ${String(c).padStart(numWidth)}`);
  return [
    `  ${header[0].padEnd(nameWidth)}  ${header[1].padStart(numWidth)}`,
    line,
    ...body,
    line,
    `  ${"TOTAL".padEnd(nameWidth)}  ${String(rows.reduce((s, [, c]) => s + c, 0)).padStart(numWidth)}`,
  ].join("\n");
}

// Host / port / database of the connection, with the credentials dropped. Printed before any
// write so the operator sees WHICH database is about to be emptied; the password is never read
// out of the URL at all, so it cannot reach the log by accident.
export function describeTarget(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default)";
    const port = u.port || "5432";
    return `host=${u.hostname} port=${port} database=${database} user=${u.username || "(none)"}`;
  } catch {
    return "host=(unparseable DATABASE_URL) port=? database=?";
  }
}

export type ResetResult = {
  deleted: Map<ModelName, number>;
  remaining: Map<ModelName, number>;
  template: { stages: number; fieldDefs: number };
};

// The wipe. One interactive transaction: either every model is emptied and the template rebuilt,
// or nothing changed. Exported for testing against a throwaway database.
export async function resetData(
  prisma: PrismaClient,
  keep: KeepList,
  opts: { rebuildTemplate: boolean } = { rebuildTemplate: true },
): Promise<ResetResult> {
  const deleted = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as ResetDb;
    const counts = new Map<ModelName, number>();
    for (const model of DELETION_ORDER) {
      const { count } = await db[model].deleteMany(whereFor(model, keep));
      counts.set(model, count);
    }
    // A preserved super admin must not be left pointing at a team or an account that no longer
    // exists. The FKs are ON DELETE SET NULL so Postgres has already done this, but asserting it
    // here matches promoteSuperAdmin's contract (role SUPER_ADMIN carries no team and no account)
    // and costs one statement.
    if (keep.userIds.length) {
      await db.user.updateMany({
        where: { id: { in: keep.userIds } },
        data: { teamId: null, accountId: null, status: "ACTIVE" },
      });
    }
    return counts;
  });

  // Rebuild the org template for each surviving company, in its own transaction so the delete is
  // never rolled back by a template failure. seedOrgTemplate is idempotent.
  const template = { stages: 0, fieldDefs: 0 };
  if (opts.rebuildTemplate) {
    for (const companyId of keep.companyIds) {
      const r = await prisma.$transaction(async (tx) =>
        seedOrgTemplate(tx as unknown as PrismaClient, companyId),
      );
      template.stages += r.stages;
      template.fieldDefs += r.fieldDefs;
    }
  }

  const remaining = await countRemaining(prisma as unknown as ResetDb);
  return { deleted, remaining, template };
}

const USAGE = `Usage:
  npx tsx prisma/scripts/reset-data.ts                  dry run: count what WOULD be deleted
  RESET_I_UNDERSTAND=yes npx tsx prisma/scripts/reset-data.ts --confirm

Options:
  --confirm        actually delete (requires RESET_I_UNDERSTAND=yes in the environment)
  --no-template    do not rebuild the org-level Stage/AccountFieldDef template afterwards`;

function createPrismaClient(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as Prisma.PrismaClientOptions);
}

async function main(argv: string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");

  const unknown = argv.filter((a) => !["--confirm", "--no-template", "--help", "-h"].includes(a));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}\n${USAGE}`);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const confirmed = argv.includes("--confirm");
  const rebuildTemplate = !argv.includes("--no-template");

  // Printed FIRST, before any read, so it is at the top of the log whatever happens next.
  console.log(`target: ${describeTarget(url)}`);
  console.log(`mode:   ${confirmed ? "DELETE (--confirm)" : "dry run (default)"}`);
  console.log("");

  const prisma = createPrismaClient(url);
  try {
    const db = prisma as unknown as ResetDb;
    const keep = await resolveKeepList(db);

    console.log(
      keep.userIds.length
        ? `preserving ${keep.userIds.length} SUPER_ADMIN login(s): ${keep.emails.join(", ")}`
        : "preserving 0 SUPER_ADMIN logins — THERE ARE NONE IN THIS DATABASE",
    );
    console.log(
      keep.companyIds.length
        ? `preserving ${keep.companyIds.length} company row(s) those logins belong to (every team is still deleted)`
        : "preserving 0 company rows",
    );
    if (!keep.userIds.length) {
      console.log(
        "WARNING: no SUPER_ADMIN exists here, so this wipe would leave NO login at all.\n" +
          "         Provision one first: npx tsx prisma/scripts/super-admin.ts --promote <email>",
      );
    }
    if (keep.companyIds.length > 1) {
      console.log(
        "NOTE: more than one company survives, because the super admins belong to different ones.",
      );
    }
    console.log("");

    const targets = await countTargets(db, keep);
    console.log("would delete:");
    console.log(renderTable([...targets].map(([m, c]) => [m, c]), ["model", "rows"]));
    console.log("");

    if (!confirmed) {
      console.log(`${DRY_RUN_NOTE}. Re-run with --confirm (and RESET_I_UNDERSTAND=yes) to delete.`);
      return;
    }
    if (process.env.RESET_I_UNDERSTAND !== "yes") {
      throw new Error(
        "--confirm requires RESET_I_UNDERSTAND=yes in the environment. Nothing was written.",
      );
    }

    console.log(`DELETING from ${describeTarget(url)} ...`);
    const result = await resetData(prisma, keep, { rebuildTemplate });

    console.log("");
    console.log("deleted:");
    console.log(renderTable([...result.deleted].map(([m, c]) => [m, c]), ["model", "rows"]));
    console.log("");
    if (rebuildTemplate) {
      console.log(
        `org template rebuilt: ${result.template.stages} stage(s), ${result.template.fieldDefs} field definition(s) (teamId = null)`,
      );
    } else {
      console.log("org template NOT rebuilt (--no-template): the next team created will have zero stages.");
    }
    console.log("");
    console.log("remaining row counts:");
    console.log(renderTable([...result.remaining].map(([m, c]) => [m, c]), ["model", "rows"]));
    console.log("");
    console.log(
      "NOTE: uploaded files on disk (Attachment.diskPath / AccountAttachment.diskPath) are NOT\n" +
        "      touched by this script — their database rows are gone, the bytes are not.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly, never on import (mirrors super-admin.ts).
if (process.argv[1] && /reset-data\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
