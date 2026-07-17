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
  await testPrisma.accountFieldValue.deleteMany();
  await testPrisma.accountFieldDef.deleteMany();
  await testPrisma.serviceFee.deleteMany();
  await testPrisma.settlementEntry.deleteMany();
  await testPrisma.partnerPayment.deleteMany();
  await testPrisma.partnerAppUser.deleteMany();
  await testPrisma.accountAttachment.deleteMany();
  await testPrisma.accountAsk.deleteMany();
  await testPrisma.accountTask.deleteMany();
  await testPrisma.accountActivity.deleteMany();
  await testPrisma.account.deleteMany();
  await testPrisma.attachment.deleteMany();
  await testPrisma.task.deleteMany();
  await testPrisma.activity.deleteMany();
  await testPrisma.lead.deleteMany();
  await testPrisma.stage.deleteMany();
  await testPrisma.invitation.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.company.deleteMany();
}
