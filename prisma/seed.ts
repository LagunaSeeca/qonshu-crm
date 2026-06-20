import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

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

  await prisma.user.upsert({
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

  await prisma.user.upsert({
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
}

main().finally(() => prisma.$disconnect());
