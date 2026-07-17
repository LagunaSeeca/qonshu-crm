import type { PrismaClient, Company, User } from "@prisma/client";
import { assertRole, type SessionUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { seedDefaultStages } from "@/lib/tenant/stages";

export async function createCompany(
  db: PrismaClient, actor: SessionUser,
  args: { name: string; slug: string; adminName: string; adminEmail: string; adminPassword: string },
): Promise<{ company: Company; admin: User }> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const passwordHash = await hashPassword(args.adminPassword);
  return db.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name: args.name, slug: args.slug } });
    await seedDefaultStages(tx as PrismaClient, company.id);
    const admin = await tx.user.create({
      data: {
        companyId: company.id, email: args.adminEmail, name: args.adminName,
        passwordHash, role: "COMPANY_ADMIN", status: "ACTIVE",
      },
    });
    return { company, admin };
  });
}
