import type { PaymentMethod, PaymentCategory, AppPlatform } from "@prisma/client";

export type RawUser = {
  externalId: string;
  name: string;
  active: boolean;
  debt: number;
  joinedAt: Date;
  platform: AppPlatform;
  installedAt: Date | null;
  lastLoginAt: Date | null;
  appToken: string | null;
};
export type RawPayment = { externalUserId: string; occurredAt: Date; amount: number; method: PaymentMethod; category: PaymentCategory };

// What the sync layer hands a source for one account. `externalKey` is the manually-entered
// Account.externalPartnerKey — the ONLY thing a real (Django) source should match on, so a
// partner can never receive another partner's data. `accountId` is our internal id (the mock
// keys its deterministic demo data off it; a real source ignores it).
export type SourceContext = { accountId: string; externalKey: string | null };

export interface PartnerAnalyticsSource {
  fetchUsers(ctx: SourceContext): Promise<RawUser[]>;
  fetchPayments(ctx: SourceContext, since: Date): Promise<RawPayment[]>;
}

// tiny deterministic PRNG (mulberry32) seeded from the account id
function seedFrom(id: string): () => number {
  let h = 1779033703 ^ id.length;
  for (let i = 0; i < id.length; i++) { h = Math.imul(h ^ id.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const METHODS: PaymentMethod[] = ["CARD", "MANUAL", "CASH"];
const CATS: PaymentCategory[] = ["APARTMENT", "PARKING", "NON_RESIDENTIAL", "UTILITY"];
const PLATFORMS: AppPlatform[] = ["IOS", "ANDROID"];

export class MockPartnerAnalyticsSource implements PartnerAnalyticsSource {
  async fetchUsers({ accountId }: SourceContext): Promise<RawUser[]> {
    const rnd = seedFrom(accountId + ":u");
    const n = 8 + Math.floor(rnd() * 8);
    return Array.from({ length: n }, (_, i) => {
      const installedAt = new Date(Date.now() - Math.floor(rnd() * 365) * 86400000);
      // Deliberate subset: only ~60% of installs ever log in, so activation rate is meaningful
      // (installs alone don't prove usage) rather than trivially 100%.
      const activated = rnd() < 0.6;
      const lastLoginAt = activated
        ? new Date(installedAt.getTime() + Math.floor(rnd() * 30) * 86400000)
        : null;
      const appToken = activated ? `tok_${accountId}_${i}_${Math.floor(rnd() * 1e9).toString(36)}` : null;
      return {
        externalId: `${accountId}-u${i}`, name: `App User ${i + 1}`,
        active: rnd() > 0.2, debt: Math.round(rnd() * 500 * 100) / 100,
        joinedAt: new Date(Date.now() - Math.floor(rnd() * 365) * 86400000),
        platform: PLATFORMS[Math.floor(rnd() * PLATFORMS.length)],
        installedAt, lastLoginAt, appToken,
      };
    });
  }
  async fetchPayments(ctx: SourceContext, since: Date): Promise<RawPayment[]> {
    const { accountId } = ctx;
    const users = await this.fetchUsers(ctx);
    const rnd = seedFrom(accountId + ":p");
    const out: RawPayment[] = [];
    const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86400000));
    for (const u of users.filter((x) => x.active)) {
      const perDay = rnd() * 0.5;
      for (let d = 0; d < days; d++) {
        if (rnd() > perDay) continue;
        out.push({ externalUserId: u.externalId, occurredAt: new Date(since.getTime() + d * 86400000 + Math.floor(rnd() * 86400000)),
          amount: Math.round((10 + rnd() * 490) * 100) / 100, method: METHODS[Math.floor(rnd() * METHODS.length)], category: CATS[Math.floor(rnd() * CATS.length)] });
      }
    }
    return out;
  }
}
