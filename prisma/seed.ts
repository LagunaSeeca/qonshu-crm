import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { seedDefaultStages } from "../src/lib/tenant/stages";
import { syncAccountAnalytics } from "../src/lib/analytics/sync";
import { MockPartnerAnalyticsSource } from "../src/lib/analytics/source";

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
      value: 50000,
      priority: "HIGH" as const,
      stageId: stages[0]?.id, // New
      ownerId: admin.id,
    },
    {
      title: "TechStart Partnership",
      contactName: "Sarah Johnson",
      email: "sarah@techstart.com",
      companyName: "TechStart Inc",
      value: 75000,
      priority: "HIGH" as const,
      stageId: stages[2]?.id, // Qualified
      ownerId: member.id,
    },
    {
      title: "Global Industries RFP",
      contactName: "Michael Chen",
      email: "michael@global.com",
      companyName: "Global Industries",
      value: 125000,
      priority: "MEDIUM" as const,
      stageId: stages[3]?.id, // Proposal
      ownerId: admin.id,
    },
    {
      title: "StartupX Negotiation",
      contactName: "Emma Davis",
      email: "emma@startupx.com",
      companyName: "StartupX",
      value: 35000,
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
        value: leadData.value,
        currency: "USD",
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
      value: 250000,
      status: "ACTIVE" as const,
      primaryContactName: "Alice Williams",
      primaryContactEmail: "alice@acme-ent.com",
      accountManagerId: admin.id,
    },
    {
      name: "TechFlow Solutions",
      industry: "Software",
      value: 180000,
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
        value: accountData.value,
        currency: "USD",
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

    // Create 2 COLLECTED entries and 1 TRANSFER entry
    const now = new Date();

    // First COLLECTED entry (older)
    await prisma.settlementEntry.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        type: "COLLECTED",
        amount: 5000,
        method: null,
        occurredAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), // 14 days ago
        note: `Payment received from ${account.primaryContactName}`,
        createdById: admin.id,
      },
    });

    // Second COLLECTED entry (more recent)
    await prisma.settlementEntry.create({
      data: {
        companyId: co.id,
        accountId: account.id,
        type: "COLLECTED",
        amount: 3200,
        method: null,
        occurredAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
        note: `Additional payment collected`,
        createdById: admin.id,
      },
    });

    // TRANSFER entry (CASH method)
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

    totalSettlementEntries += 3;
    totalOwed += 5000 + 3200 - 4000; // collected - transferred
  }

  console.log(`seeded: demo settlement entries — ${totalSettlementEntries} entries, ${totalOwed} total owed across demo accounts`);
}

main().finally(() => prisma.$disconnect());
