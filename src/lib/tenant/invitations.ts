import { randomUUID } from "crypto";
import type { PrismaClient, Invitation, Role, User } from "@prisma/client";
import type { TenantContext } from "./context";
import { hashPassword } from "@/lib/auth/password";
import { sendInvite } from "@/lib/email/sendInvite";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const baseUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export class InvalidInvitationRoleError extends Error {}

export async function createInvitation(
  db: PrismaClient, ctx: TenantContext,
  args: { email: string; role: Role; invitedById: string; accountId?: string | null },
): Promise<Invitation> {
  // PARTNER_VIEWER requires exactly one account, scoped to this company (fail closed:
  // no silent fallback). Every other role must carry no accountId at all.
  let accountId: string | null = null;
  if (args.role === "PARTNER_VIEWER") {
    if (!args.accountId) throw new InvalidInvitationRoleError("accountId is required for PARTNER_VIEWER");
    const acc = await db.account.findFirst({ where: { id: args.accountId, companyId: ctx.companyId } });
    if (!acc) throw new InvalidInvitationRoleError("accountId does not belong to this company");
    accountId = args.accountId;
  } else if (args.accountId) {
    throw new InvalidInvitationRoleError("accountId is only allowed for PARTNER_VIEWER invites");
  }

  const token = randomUUID();
  const inv = await db.invitation.create({
    data: { companyId: ctx.companyId, email: args.email, role: args.role, token, accountId,
            invitedById: args.invitedById, expiresAt: new Date(Date.now() + WEEK) },
  });
  await sendInvite(args.email, `${baseUrl()}/invite/accept?token=${token}`);
  return inv;
}

export async function acceptInvitation(
  db: PrismaClient,
  args: { token: string; name: string; password: string },
): Promise<User> {
  const inv = await db.invitation.findUnique({ where: { token: args.token } });
  if (!inv || inv.status !== "PENDING") throw new Error("invalid invitation");
  if (inv.expiresAt < new Date()) throw new Error("invitation expired");
  const passwordHash = await hashPassword(args.password);
  const [user] = await db.$transaction([
    db.user.create({ data: { companyId: inv.companyId, email: inv.email, name: args.name, passwordHash, role: inv.role, accountId: inv.accountId, status: "ACTIVE" } }),
    db.invitation.update({ where: { id: inv.id }, data: { status: "ACCEPTED" } }),
  ]);
  return user;
}
