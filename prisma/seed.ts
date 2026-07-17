import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { seedDefaultStages } from "../src/lib/tenant/stages";
import { syncAccountAnalytics } from "../src/lib/analytics/sync";
import { MockPartnerAnalyticsSource } from "../src/lib/analytics/source";
import { createFieldDef, setAccountFieldValue } from "../src/lib/tenant/account-fields";
import { addServiceFee, markFeePaid } from "../src/lib/tenant/service-fees";
import type { SessionUser } from "../src/lib/auth/guards";

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();

async function main() {
  const pw = await hashPassword("password123");

  await prisma.user.upsert({
    where: { email: "super@qonshu.dev" },
    update: {},
    create: {
      email: "super@qonshu.dev",
      name: "Super Admin",
      passwordHash: pw,
      role: "SUPER_ADMIN",
    },
  });

  const co = await prisma.company.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Co", slug: "demo" },
  });

  const admin = await prisma.user.upsert({
    where: { email: "admin@demo.co" },
    update: {},
    create: {
      companyId: co.id,
      email: "admin@demo.co",
      name: "Demo Admin",
      passwordHash: pw,
      role: "COMPANY_ADMIN",
    },
  });

  const member = await prisma.user.upsert({
    where: { email: "member@demo.co" },
    update: {},
    create: {
      companyId: co.id,
      email: "member@demo.co",
      name: "Demo Member",
      passwordHash: pw,
      role: "MEMBER",
    },
  });

  console.log("seeded: super@qonshu.dev / admin@demo.co / member@demo.co (password123)");

  // Seed default stages
  await seedDefaultStages(prisma, co.id);

  // Fetch stages
  const stages = await prisma.stage.findMany({
    where: { companyId: co.id },
    orderBy: { order: "asc" },
  });

  // Make demo leads idempotent: delete all demo leads first
  await prisma.lead.deleteMany({
    where: { companyId: co.id },
  });

  // Create ~4 demo leads across different stages
  const demoLeads = [
    {
      title: "Acme Corp Deal",
      contactName: "John Smith",
      email: "john@acme.com",
      companyName: "Acme Corporation",
      priority: "HIGH" as const,
      stageId: stages[0]?.id, // New
      ownerId: admin.id,
    },
    {
      title: "TechStart Partnership",
      contactName: "Sarah Johnson",
      email: "sarah@techstart.com",
      companyName: "TechStart Inc",
      priority: "HIGH" as const,
      stageId: stages[2]?.id, // Qualified
      ownerId: member.id,
    },
    {
      title: "Global Industries RFP",
      contactName: "Michael Chen",
      email: "michael@global.com",
      companyName: "Global Industries",
      priority: "MEDIUM" as const,
      stageId: stages[3]?.id, // Proposal
      ownerId: admin.id,
    },
    {
      title: "StartupX Negotiation",
      contactName: "Emma Davis",
      email: "emma@startupx.com",
      companyName: "StartupX",
      priority: "LOW" as const,
      stageId: stages[4]?.id, // Negotiation
      ownerId: member.id,
    },
  ];

  for (const leadData of demoLeads) {
    if (!leadData.stageId) continue;

    const lead = await prisma.lead.create({
      data: {
        companyId: co.id,
        title: leadData.title,
        contactName: leadData.contactName,
        email: leadData.email,
        companyName: leadData.companyName,
        priority: leadData.priority,
        stageId: leadData.stageId,
        ownerId: leadData.ownerId,
      },
    });

    // Create one Activity (NOTE)
    await prisma.activity.create({
      data: {
        companyId: co.id,
        leadId: lead.id,
        authorId: leadData.ownerId,
        kind: "NOTE",
        body: `Initial contact with ${lead.contactName}. Promising opportunity.`,
      },
    });

    // Create one Task with a due date
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7); // 7 days from now
    await prisma.task.create({
      data: {
        companyId: co.id,
        leadId: lead.id,
        title: `Follow up with ${lead.contactName}`,
        dueDate,
      },
    });
  }

  console.log(`seeded: demo CRM with 4 leads, activities, and tasks across stages`);

  // Make demo accounts idempotent: delete all demo accounts first (cascades to activities/tasks/asks/attachments)
  await prisma.account.deleteMany({
    where: { companyId: co.id },
  });

  // Create 2 demo accounts
  const demoAccounts = [
    {
      name: "Acme Enterprise",
      industry: "Technology",
      status: "ACTIVE" as const,
      primaryContactName: "Alice Williams",
      primaryContactEmail: "alice@acme-ent.com",
      accountManagerId: admin.id,
    },
    {
      name: "TechFlow Solutions",
      industry: "Software",
      status: "AT_RISK" as const,
      primaryContactName: "Bob Martinez",
      primaryContactEmail: "bob@techflow.com",
      accountManagerId: member.id,
    },
  ];

  for (let i = 0; i < demoAccounts.length; i++) {
    const accountData = demoAccounts[i];

    const account = await prisma.account.create({
      data: {
        companyId: co.id,
        name: accountData.name,
        industry: accountData.industry,
        status: accountData.status,
        primaryContactName: accountData.primaryContactName,
        primaryContactEmail: accountData.primaryContactEmail,
        accountManagerId: accountData.accountManagerId,
      },
    });

    // Create one AccountActivity (MEETING)
    await prisma.accountActivity.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        authorId: accountData.accountManagerId,
        kind: "MEETING",
        body: `Initial account review meeting with ${account.primaryContactName}. Discussed quarterly goals and initiatives.`,
        outcome: "Positive engagement. Next review in 30 days.",
      },
    });

    // Create one AccountTask with a due date
    const taskDueDate = new Date();
    taskDueDate.setDate(taskDueDate.getDate() + 14); // 14 days from now
    await prisma.accountTask.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        title: `Prepare quarterly business review for ${account.name}`,
        dueDate: taskDueDate,
      },
    });

    // Create asks: one OPEN, one RESOLVED
    // First ask: OPEN
    await prisma.accountAsk.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        title: `Needs: Custom integration support`,
        detail: `${account.primaryContactName} requested custom API integration capabilities.`,
        status: "OPEN",
        authorId: accountData.accountManagerId,
      },
    });

    // Second ask: RESOLVED
    await prisma.accountAsk.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        title: `License renewal discussion`,
        detail: `Follow up on annual licensing renewal and volume discount negotiation.`,
        status: "RESOLVED",
        resolvedAt: new Date(),
        authorId: accountData.accountManagerId,
      },
    });
  }

  console.log(`seeded: 2 demo accounts with activities, tasks, and asks`);

  // Seed a demo partner login, tied to the first demo account (Acme Enterprise).
  // PARTNER_VIEWER is read-only and scoped to exactly this one account.
  const firstDemoAccount = await prisma.account.findFirstOrThrow({
    where: { companyId: co.id, name: demoAccounts[0].name },
  });
  await prisma.user.upsert({
    where: { email: "partner@demo.co" },
    update: { accountId: firstDemoAccount.id, role: "PARTNER_VIEWER" },
    create: {
      companyId: co.id,
      email: "partner@demo.co",
      name: "Demo Partner",
      passwordHash: pw,
      role: "PARTNER_VIEWER",
      accountId: firstDemoAccount.id,
    },
  });

  console.log(`seeded: partner@demo.co / password123 (read-only, scoped to ${firstDemoAccount.name})`);

  // Seed mock analytics for each demo account
  const source = new MockPartnerAnalyticsSource();
  let totalAppUsers = 0;
  let totalPayments = 0;

  for (const accountData of demoAccounts) {
    const account = await prisma.account.findFirst({
      where: { companyId: co.id, name: accountData.name },
    });
    if (!account) continue;

    const { users, payments } = await syncAccountAnalytics(prisma, account.id, co.id, source);
    totalAppUsers += users;
    totalPayments += payments;
  }

  console.log(`seeded: mock partner analytics — ${totalAppUsers} app users, ${totalPayments} payments across demo accounts`);

  // Seed demo settlement entries (idempotent)
  await prisma.settlementEntry.deleteMany({
    where: { companyId: co.id },
  });

  let totalSettlementEntries = 0;
  let totalOwed = 0;

  for (const accountData of demoAccounts) {
    const account = await prisma.account.findFirst({
      where: { companyId: co.id, name: accountData.name },
    });
    if (!account) continue;

    // Create 3 COLLECTED entries (cash / bank transfer / manual) and 2 TRANSFER entries (cash / bank transfer)
    const now = new Date();

    // COLLECTED — cash (oldest)
    await prisma.settlementEntry.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        type: "COLLECTED",
        amount: 5000,
        method: "CASH",
        occurredAt: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000), // 21 days ago
        note: `Cash payment received from ${account.primaryContactName}`,
        createdById: admin.id,
      },
    });

    // COLLECTED — bank transfer
    await prisma.settlementEntry.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        type: "COLLECTED",
        amount: 3200,
        method: "BANK_TRANSFER",
        occurredAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), // 14 days ago
        note: `Bank transfer payment collected`,
        createdById: admin.id,
      },
    });

    // COLLECTED — manual
    await prisma.settlementEntry.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        type: "COLLECTED",
        amount: 1500,
        method: "MANUAL",
        occurredAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
        note: `Manually recorded payment`,
        createdById: admin.id,
      },
    });

    // TRANSFER — cash
    await prisma.settlementEntry.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        type: "TRANSFER",
        amount: 4000,
        method: "CASH",
        occurredAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
        note: `Cash transfer completed`,
        createdById: admin.id,
      },
    });

    // TRANSFER — bank transfer
    await prisma.settlementEntry.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        type: "TRANSFER",
        amount: 1200,
        method: "BANK_TRANSFER",
        occurredAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
        note: `Bank transfer to partner completed`,
        createdById: admin.id,
      },
    });

    totalSettlementEntries += 5;
    totalOwed += 5000 + 3200 + 1500 - (4000 + 1200); // collected - transferred
  }

  console.log(`seeded: demo settlement entries — ${totalSettlementEntries} entries, ${totalOwed} total owed across demo accounts`);

  // Seed demo custom fields (idempotent: clear the company's defs first, cascades their values)
  await prisma.accountFieldDef.deleteMany({
    where: { companyId: co.id },
  });

  const adminUser: SessionUser = { id: admin.id, companyId: co.id, role: "COMPANY_ADMIN" };
  const totalAreaDef = await createFieldDef(prisma, adminUser, { label: "Total area", type: "NUMBER" });
  const contractValueDef = await createFieldDef(prisma, adminUser, { label: "Contract value", type: "CURRENCY" });

  const demoFieldValues: Record<string, { totalArea: string; contractValue: string }> = {
    "Acme Enterprise": { totalArea: "12500", contractValue: "48000" },
    "TechFlow Solutions": { totalArea: "8200", contractValue: "21000" },
  };

  let totalFieldValues = 0;
  for (const accountData of demoAccounts) {
    const account = await prisma.account.findFirst({
      where: { companyId: co.id, name: accountData.name },
    });
    if (!account) continue;
    const values = demoFieldValues[accountData.name];
    if (!values) continue;
    await setAccountFieldValue(prisma, adminUser, account.id, totalAreaDef.id, values.totalArea);
    await setAccountFieldValue(prisma, adminUser, account.id, contractValueDef.id, values.contractValue);
    totalFieldValues += 2;
  }

  console.log(`seeded: 2 demo custom fields (Total area, Contract value) with ${totalFieldValues} values across demo accounts`);

  // Seed demo service fees (idempotent: clear the company's fees first)
  await prisma.serviceFee.deleteMany({
    where: { companyId: co.id },
  });

  const feeMonths = [2, 1, 0].map((monthsAgo) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  });

  let totalServiceFees = 0;
  for (const accountData of demoAccounts) {
    const account = await prisma.account.findFirst({
      where: { companyId: co.id, name: accountData.name },
    });
    if (!account) continue;

    // Two months ago and last month: billed and PAID. Current month: billed, still UNPAID.
    const paidMonths = feeMonths.slice(0, 2);
    const unpaidMonth = feeMonths[2];

    for (const periodMonth of paidMonths) {
      const fee = await addServiceFee(prisma, adminUser, account.id, { periodMonth, amount: 500 });
      await markFeePaid(prisma, adminUser, fee.id, { method: "BANK_TRANSFER", paidAt: new Date(periodMonth.getTime() + 3 * 24 * 60 * 60 * 1000) });
      totalServiceFees++;
    }
    await addServiceFee(prisma, adminUser, account.id, { periodMonth: unpaidMonth, amount: 500 });
    totalServiceFees++;
  }

  console.log(`seeded: demo service fees — ${totalServiceFees} fees (2 paid + 1 unpaid per account) across demo accounts`);
}

main().finally(() => prisma.$disconnect());
