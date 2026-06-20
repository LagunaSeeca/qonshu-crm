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
  // Use raw SQL to force a clean state
  try {
    await testPrisma.$executeRawUnsafe(`DELETE FROM "Invitation"`);
    await testPrisma.$executeRawUnsafe(`DELETE FROM "User"`);
    await testPrisma.$executeRawUnsafe(`DELETE FROM "Company"`);
  } catch (e) {
    // If raw SQL fails, try Prisma methods
    await testPrisma.invitation.deleteMany().catch(() => {});
    await testPrisma.user.deleteMany().catch(() => {});
    await testPrisma.company.deleteMany().catch(() => {});
  }
}
