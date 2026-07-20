import type { PrismaClient } from "@prisma/client";
import type { PartnerAnalyticsSource, SourceContext } from "./source";

export async function syncAccountAnalytics(db: PrismaClient, accountId: string, companyId: string, source: PartnerAnalyticsSource): Promise<{ users: number; payments: number }> {
  // Resolve the account's manual mapping key. A real source matches partner data by THIS key,
  // never by the display name — the mapping is what keeps one partner's data off another's
  // account. Everything written below is stamped with this exact accountId, so isolation holds
  // as long as the source returned this account's own rows.
  const account = await db.account.findFirst({ where: { id: accountId, companyId }, select: { externalPartnerKey: true } });
  const ctx: SourceContext = { accountId, externalKey: account?.externalPartnerKey ?? null };
  const rawUsers = await source.fetchUsers(ctx);
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
  const rawPayments = await source.fetchPayments(ctx, since);
  await db.partnerPayment.deleteMany({ where: { accountId } });
  for (const p of rawPayments) {
    const appUserId = idByExternal.get(p.externalUserId);
    if (!appUserId) continue;
    await db.partnerPayment.create({ data: { companyId, accountId, appUserId, occurredAt: p.occurredAt, amount: p.amount, method: p.method, category: p.category } });
  }
  return { users: rawUsers.length, payments: rawPayments.length };
}
