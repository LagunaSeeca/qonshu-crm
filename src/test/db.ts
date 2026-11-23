import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

function createTestPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST environment variable is not set");
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

export const testPrisma = createTestPrismaClient();

export async function resetDb() {
  // FIRST, and never relying on a cascade: PartnerLinkAudit is deliberately built to SURVIVE the
  // deletion of its account, its company and its actor (nullable accountId with SET NULL, bare
  // companyId/actorId columns, no cascade into the table from anywhere). That durability means
  // nothing else here clears it, so without this line its rows leak into every later test file.
  await testPrisma.partnerLinkAudit.deleteMany();
  await testPrisma.accountFieldValue.deleteMany();
  await testPrisma.accountFieldDef.deleteMany();
  await testPrisma.serviceFee.deleteMany();
  await testPrisma.settlementEntry.deleteMany();
  await testPrisma.accountAttachment.deleteMany();
  await testPrisma.accountAsk.deleteMany();
  await testPrisma.accountTask.deleteMany();
  await testPrisma.accountActivity.deleteMany();
  // Must precede User: Account.accountManagerId is now a real RESTRICT relation to User, so a
  // surviving account blocks the deletion of the user who manages it.
  await testPrisma.account.deleteMany();
  await testPrisma.attachment.deleteMany();
  await testPrisma.task.deleteMany();
  await testPrisma.activity.deleteMany();
  await testPrisma.lead.deleteMany();
  await testPrisma.stage.deleteMany();
  await testPrisma.invitation.deleteMany();
  await testPrisma.user.deleteMany();
  // Must follow Lead, Account, Stage, AccountFieldDef and User: Lead.teamId and Account.teamId
  // are RESTRICT, so a team still holding either cannot be deleted.
  await testPrisma.team.deleteMany();
  await testPrisma.company.deleteMany();
}
