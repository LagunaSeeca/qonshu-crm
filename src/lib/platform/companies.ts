import type { PrismaClient, Company, Invitation } from "@prisma/client";
import { assertRole, type SessionUser } from "@/lib/auth/guards";
import { createInvitation } from "@/lib/tenant/invitations";
import { seedDefaultStages } from "@/lib/tenant/stages";

export async function createCompany(
  db: PrismaClient, actor: SessionUser,
  args: { name: string; slug: string; adminEmail: string },
): Promise<{ company: Company; invitation: Invitation }> {
  assertRole(actor, ["SUPER_ADMIN"]);
  return db.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name: args.name, slug: args.slug } });
    await seedDefaultStages(tx as PrismaClient, company.id);
    const invitation = await createInvitation(tx as PrismaClient, { companyId: company.id }, {
      email: args.adminEmail, role: "COMPANY_ADMIN", invitedById: actor.id,
    });
    return { company, invitation };
  });
}
