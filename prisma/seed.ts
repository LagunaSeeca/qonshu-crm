import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { seedDefaultStages } from "../src/lib/tenant/stages";

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
}

main().finally(() => prisma.$disconnect());
