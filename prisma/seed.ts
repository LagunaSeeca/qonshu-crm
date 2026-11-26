import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { seedOrgTemplate } from "../src/lib/tenant/team-template";
import { createTeamWithAdmin } from "../src/lib/tenant/teams";
import { createLead, moveLeadStage } from "../src/lib/tenant/leads";
import { createAccountWithLogin, createPartnerLogin } from "../src/lib/tenant/accounts";
import { normalizeBuildingName } from "../src/lib/tenant/building-claim";
import { setAccountFieldValue } from "../src/lib/tenant/account-fields";
import { addServiceFee, markFeePaid } from "../src/lib/tenant/service-fees";
import type { SessionUser } from "../src/lib/auth/guards";

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const TEAM_NAME = "Baku Sales";

// Qonshu is ONE company; the sales team is the tenant boundary. Idempotent: every block checks
// for what it would create (by email, team name, or normalized building key) and skips if present.
async function main() {
  // Local dev keeps the convenient shared password; production MUST set SEED_PASSWORD
  // to a strong value so the demo logins aren't a public back door.
  const seedPassword = process.env.SEED_PASSWORD ?? "password123";
  const pw = await hashPassword(seedPassword);

  // 1. Org template first (teamId = NULL rows). Read once, at team-creation time.
  const company = await prisma.company.upsert({
    where: { slug: "qonshu" },
    update: {},
    create: { name: "Qonshu", slug: "qonshu" },
  });
  await seedOrgTemplate(prisma, company.id);

  // 2. The owner: companyId set (leadScopeWhere throws without it), no team.
  const owner = await prisma.user.upsert({
    where: { email: "super@qonshu.dev" },
    update: { companyId: company.id, teamId: null, role: "SUPER_ADMIN", status: "ACTIVE" },
    create: {
      companyId: company.id, teamId: null, email: "super@qonshu.dev", name: "Qonshu Owner",
      passwordHash: pw, role: "SUPER_ADMIN",
    },
  });
  const ownerSession: SessionUser = { id: owner.id, companyId: company.id, teamId: null, role: "SUPER_ADMIN" };

  // 3. One team + admin (clones the template into the team's OWN stage/field rows).
  let team = await prisma.team.findUnique({
    where: { companyId_name: { companyId: company.id, name: TEAM_NAME } },
  });
  if (!team) {
    ({ team } = await createTeamWithAdmin(prisma, ownerSession, {
      name: TEAM_NAME, adminName: "Team Admin", adminEmail: "admin@qonshu.dev", adminPassword: seedPassword,
    }));
  }
  const teamId = team.id;

  const memberSpecs = [
    ["member1@qonshu.dev", "Member One"],
    ["member2@qonshu.dev", "Member Two"],
  ] as const;
  const members = [];
  for (const [email, name] of memberSpecs) {
    members.push(await prisma.user.upsert({
      where: { email },
      update: { companyId: company.id, teamId, role: "MEMBER", status: "ACTIVE" },
      create: { companyId: company.id, teamId, email, name, passwordHash: pw, role: "MEMBER" },
    }));
  }
  const [m1, m2] = members;
  const memberSession = (id: string): SessionUser => ({ id, companyId: company.id, teamId, role: "MEMBER" });
  const m1Session = memberSession(m1.id);
  const m2Session = memberSession(m2.id);

  // The team's OWN stages (teamId = team.id), never the template rows.
  const stages = await prisma.stage.findMany({ where: { companyId: company.id, teamId }, orderBy: { order: "asc" } });
  const stageId = (name: string) => {
    const s = stages.find((x) => x.name === name);
    if (!s) throw new Error(`team stage "${name}" missing`);
    return s.id;
  };

  const keyTaken = async (name: string) => {
    const buildingKey = normalizeBuildingName(name);
    const [l, a] = await Promise.all([
      prisma.lead.findFirst({ where: { companyId: company.id, buildingKey }, select: { id: true } }),
      prisma.account.findFirst({ where: { companyId: company.id, buildingKey }, select: { id: true } }),
    ]);
    return Boolean(l || a);
  };

  // 4. Leads, split across the two members.
  const leadSpecs: { who: SessionUser; building: string; title: string; contact: string; stage: string; priority: "LOW" | "MEDIUM" | "HIGH" }[] = [
    { who: m1Session, building: "Sabah City", title: "Sabah City elevator service", contact: "Rashad Aliyev", stage: "New", priority: "HIGH" },
    { who: m1Session, building: "Nizami Park Residence", title: "Nizami Park contract", contact: "Leyla Mammadova", stage: "Qualified", priority: "MEDIUM" },
    { who: m1Session, building: "Port Baku Towers", title: "Port Baku Towers deal", contact: "Elvin Hasanov", stage: "Proposal", priority: "HIGH" },
    { who: m2Session, building: "Ganjlik Plaza", title: "Ganjlik Plaza onboarding", contact: "Aysel Guliyeva", stage: "Contacted", priority: "MEDIUM" },
    { who: m2Session, building: "Dream Town", title: "Dream Town renewal", contact: "Kamran Ismayilov", stage: "Negotiation", priority: "HIGH" },
    { who: m2Session, building: "Yasamal Heights", title: "Yasamal Heights lead", contact: "Nigar Huseynova", stage: "New", priority: "LOW" },
  ];
  let leadsCreated = 0;
  for (const s of leadSpecs) {
    if (await keyTaken(s.building)) continue;
    await createLead(prisma, s.who, {
      title: s.title, contactName: s.contact, companyName: s.building, stageId: stageId(s.stage),
      priority: s.priority, email: `${normalizeBuildingName(s.building).replace(/\W+/g, ".")}@example.com`,
    });
    leadsCreated++;
  }

  // Won lead + converted account (owned by member1). Goes through moveLeadStage so it gets wonAt
  // and auto-converts into its account via the real conversion path.
  const wonName = "Narimanov Gardens";
  let wonConverted = false;
  if (!(await keyTaken(wonName))) {
    const lead = await createLead(prisma, m1Session, {
      title: "Narimanov Gardens contract", contactName: "Orkhan Safarov", companyName: wonName,
      stageId: stageId("Negotiation"), priority: "HIGH", email: "orkhan@narimanov-gardens.example",
    });
    const moved = await moveLeadStage(prisma, m1Session, lead.id, stageId("Won"));
    if (!moved.autoConverted) throw new Error(`won lead did not auto-convert: ${moved.reason}`);
    wonConverted = true;
    leadsCreated++;
    const acc = await prisma.account.findFirstOrThrow({
      where: { companyId: company.id, buildingKey: normalizeBuildingName(wonName) },
    });
    await createPartnerLogin(prisma, m1Session, acc.id, {
      name: "Narimanov Gardens Rep", email: "rep.narimanov@qonshu.dev", password: seedPassword,
    });
  }

  // 5. Directly created accounts, one per member, each with its partner-representative login.
  const accountSpecs = [
    { who: m1Session, name: "Khatai Business Center", contact: "Tural Abbasov", status: "ACTIVE" as const, rep: "rep.khatai@qonshu.dev" },
    { who: m2Session, name: "Bina Residence", contact: "Samira Rzayeva", status: "AT_RISK" as const, rep: "rep.bina@qonshu.dev" },
  ];
  let accountsCreated = wonConverted ? 1 : 0;
  for (const a of accountSpecs) {
    if (await keyTaken(a.name)) continue;
    await createAccountWithLogin(prisma, a.who, {
      name: a.name, status: a.status, industry: "Residential", primaryContactName: a.contact,
      primaryContactEmail: a.rep.replace("rep.", "contact."),
      accountManagerId: a.who.id,
      partnerLogin: { name: `${a.name} Rep`, email: a.rep, password: seedPassword },
    });
    accountsCreated++;
  }

  // 5b. Money model: every demo building has an agreed monthly rate, and one collects its own
  // money (SELF) so the "nothing owed" path has data. Written here, not in createAccountWithLogin,
  // so it also lands on accounts from a previous seed run. Re-runs are no-ops.
  await prisma.account.updateMany({
    where: { companyId: company.id, monthlyServiceFee: null },
    // A STRING, not 500: money is a decimal string everywhere on the way in (see FeeAmountSchema
    // and setServiceFeeRate). The seed was the last number-valued write left on this path.
    data: { monthlyServiceFee: "500" },
  });
  await prisma.account.updateMany({
    where: { companyId: company.id, name: "Bina Residence" },
    data: { collectionMode: "SELF" },
  });

  // 6. Settlements, field values and service fees via the lib functions, once per account
  // (skipped when the account already carries them).
  const accounts = await prisma.account.findMany({ where: { companyId: company.id, teamId }, orderBy: { name: "asc" } });
  const fieldDefs = await prisma.accountFieldDef.findMany({ where: { companyId: company.id, teamId } });
  const defId = (label: string) => {
    const d = fieldDefs.find((x) => x.label === label);
    if (!d) throw new Error(`team field "${label}" missing`);
    return d.id;
  };
  const now = Date.now();
  let entries = 0, fees = 0, values = 0;
  for (const [i, acc] of accounts.entries()) {
    const actor = acc.accountManagerId === m2.id ? m2Session : m1Session;
    if ((await prisma.settlementEntry.count({ where: { accountId: acc.id } })) === 0) {
      // Transfers only. "Collected" is no longer a stored row — it is the partner API's
      // `amount_by_card` for the period, fetched live (see src/lib/tenant/settlements.ts) — and
      // the rows are written directly because settlement writes are SUPER_ADMIN-only now, while
      // `actor` here is the account's own manager.
      const rows = [
        { amount: 4000, method: "CASH", ago: 3 },
        { amount: 1200, method: "BANK_TRANSFER", ago: 1 },
      ] as const;
      for (const r of rows) {
        await prisma.settlementEntry.create({
          data: {
            companyId: acc.companyId, accountId: acc.id, type: "TRANSFER", amount: r.amount,
            method: r.method, occurredAt: new Date(now - r.ago * DAY),
            note: `Transferred for ${acc.name}`, createdById: actor.id,
          },
        });
        entries++;
      }
    }
    if ((await prisma.accountFieldValue.count({ where: { accountId: acc.id } })) === 0) {
      await setAccountFieldValue(prisma, actor, acc.id, defId("Total area"), String(8000 + i * 2100));
      await setAccountFieldValue(prisma, actor, acc.id, defId("Contract value"), String(21000 + i * 9000));
      values += 2;
    }
    if ((await prisma.serviceFee.count({ where: { accountId: acc.id } })) === 0) {
      for (const monthsAgo of [2, 1, 0]) {
        const d = new Date();
        const periodMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsAgo, 1));
        const fee = await addServiceFee(prisma, actor, acc.id, { periodMonth, amount: "500" });
        // Two older months paid, current month left unpaid.
        if (monthsAgo > 0) {
          await markFeePaid(prisma, actor, fee.id, { method: "BANK_TRANSFER", paidAt: new Date(periodMonth.getTime() + 3 * DAY) });
        }
        fees++;
      }
    }
  }

  console.log(
    `seeded: company Qonshu, team "${TEAM_NAME}" - new this run: ${leadsCreated} leads, ${accountsCreated} accounts, ` +
      `${entries} settlement entries, ${values} field values, ${fees} service fees`,
  );
  console.log(`seeded logins (password: ${process.env.SEED_PASSWORD ? "from SEED_PASSWORD env" : "password123"}):`);
  console.log(`  super@qonshu.dev          SUPER_ADMIN    (owner, no team)`);
  console.log(`  admin@qonshu.dev          COMPANY_ADMIN  team "${TEAM_NAME}"`);
  console.log(`  member1@qonshu.dev        MEMBER         team "${TEAM_NAME}"`);
  console.log(`  member2@qonshu.dev        MEMBER         team "${TEAM_NAME}"`);
  const reps = await prisma.user.findMany({
    where: { companyId: company.id, role: "PARTNER_VIEWER" }, orderBy: { email: "asc" },
    select: { email: true, account: { select: { name: true } } },
  });
  for (const r of reps) console.log(`  ${r.email.padEnd(25)} PARTNER_VIEWER (read-only, building: ${r.account?.name})`);
}

main().finally(() => prisma.$disconnect());
