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
  await testPrisma.invitation.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.company.deleteMany();
}
