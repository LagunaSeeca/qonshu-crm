import type { PrismaClient } from "@prisma/client";
import type { PartnerAnalyticsSource } from "./source";

export async function syncAccountAnalytics(db: PrismaClient, accountId: string, companyId: string, source: PartnerAnalyticsSource): Promise<{ users: number; payments: number }> {
  const rawUsers = await source.fetchUsers(accountId);
  for (const u of rawUsers) {
    await db.partnerAppUser.upsert({
      where: { accountId_externalId: { accountId, externalId: u.externalId } },
      update: {
        name: u.name, active: u.active, debt: u.debt, joinedAt: u.joinedAt,
        platform: u.platform, installedAt: u.installedAt, lastLoginAt: u.lastLoginAt, appToken: u.appToken,
      },
      create: {
        companyId, accountId, externalId: u.externalId, name: u.name, active: u.active, debt: u.debt, joinedAt: u.joinedAt,
        platform: u.platform, installedAt: u.installedAt, lastLoginAt: u.lastLoginAt, appToken: u.appToken,
      },
    });
  }
  const idByExternal = new Map((await db.partnerAppUser.findMany({ where: { accountId } })).map((u) => [u.externalId, u.id]));
  const since = new Date(Date.now() - 90 * 86400000);
  const rawPayments = await source.fetchPayments(accountId, since);
  await db.partnerPayment.deleteMany({ where: { accountId } });
  for (const p of rawPayments) {
    const appUserId = idByExternal.get(p.externalUserId);
    if (!appUserId) continue;
    await db.partnerPayment.create({ data: { companyId, accountId, appUserId, occurredAt: p.occurredAt, amount: p.amount, method: p.method, category: p.category } });
  }
  return { users: rawUsers.length, payments: rawPayments.length };
}
