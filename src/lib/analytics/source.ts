import type { PaymentMethod, PaymentCategory } from "@prisma/client";

export type RawUser = { externalId: string; name: string; active: boolean; debt: number; joinedAt: Date };
export type RawPayment = { externalUserId: string; occurredAt: Date; amount: number; method: PaymentMethod; category: PaymentCategory };
export interface PartnerAnalyticsSource {
  fetchUsers(accountId: string): Promise<RawUser[]>;
  fetchPayments(accountId: string, since: Date): Promise<RawPayment[]>;
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

export class MockPartnerAnalyticsSource implements PartnerAnalyticsSource {
  async fetchUsers(accountId: string): Promise<RawUser[]> {
    const rnd = seedFrom(accountId + ":u");
    const n = 8 + Math.floor(rnd() * 8);
    return Array.from({ length: n }, (_, i) => ({
      externalId: `${accountId}-u${i}`, name: `App User ${i + 1}`,
      active: rnd() > 0.2, debt: Math.round(rnd() * 500 * 100) / 100,
      joinedAt: new Date(Date.now() - Math.floor(rnd() * 365) * 86400000),
    }));
  }
  async fetchPayments(accountId: string, since: Date): Promise<RawPayment[]> {
    const users = await this.fetchUsers(accountId);
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
