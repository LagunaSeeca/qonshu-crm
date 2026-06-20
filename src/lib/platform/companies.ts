import type { PrismaClient, Company, Invitation } from "@prisma/client";
import { assertRole, type SessionUser } from "@/lib/auth/guards";
import { createInvitation } from "@/lib/tenant/invitations";

export async function createCompany(
  db: PrismaClient, actor: SessionUser,
  args: { name: string; slug: string; adminEmail: string },
): Promise<{ company: Company; invitation: Invitation }> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const company = await db.company.create({ data: { name: args.name, slug: args.slug } });
  const invitation = await createInvitation(db, { companyId: company.id }, {
    email: args.adminEmail, role: "COMPANY_ADMIN", invitedById: actor.id,
  });
  return { company, invitation };
}
