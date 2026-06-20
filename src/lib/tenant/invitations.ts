import { randomUUID } from "crypto";
import type { PrismaClient, Invitation, Role, User } from "@prisma/client";
import type { TenantContext } from "./context";
import { hashPassword } from "@/lib/auth/password";
import { sendInvite } from "@/lib/email/sendInvite";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const baseUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export async function createInvitation(
  db: PrismaClient, ctx: TenantContext,
  args: { email: string; role: Role; invitedById: string },
): Promise<Invitation> {
  const token = randomUUID();
  const inv = await db.invitation.create({
    data: { companyId: ctx.companyId, email: args.email, role: args.role, token,
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
    db.user.create({ data: { companyId: inv.companyId, email: inv.email, name: args.name, passwordHash, role: inv.role, status: "ACTIVE" } }),
    db.invitation.update({ where: { id: inv.id }, data: { status: "ACCEPTED" } }),
  ]);
  return user;
}
