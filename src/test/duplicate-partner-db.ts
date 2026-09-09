import type { Account } from "@prisma/client";
import { testPrisma } from "./db";

// `Account.externalPartnerKey` is `@@unique`, so a second account claiming one complex can no
// longer be inserted — which is the whole point of the constraint, but it also means the
// defensive dedup in company-analytics.ts / reports.ts / platform/overview.ts can no longer be
// driven from real rows.
//
// That dedup is not dead code: it is what protects the analytics totals from a duplicate that
// predates the constraint, and in platform/overview.ts it is what NAMES the duplicate for the one
// person who can unlink it. So the duplicate is injected at the query boundary instead: a Prisma
// client that behaves exactly like the real one except that one account comes back wearing
// someone else's partner name.
//
// Everything except `account.findMany` passes straight through, methods bound to the real
// delegate, so the surrounding query (groupBy counts, companies, leads) is genuinely the DB's.
export function dbWithPhantomPartnerKey(accountId: string, partnerName: string): typeof testPrisma {
  return new Proxy(testPrisma, {
    get(target, prop, receiver) {
      if (prop !== "account") return Reflect.get(target, prop, receiver);
      const delegate = target.account;
      return new Proxy(delegate, {
        get(accTarget, accProp) {
          if (accProp !== "findMany") {
            const value = Reflect.get(accTarget, accProp);
            return typeof value === "function" ? value.bind(accTarget) : value;
          }
          return async (args: Parameters<typeof delegate.findMany>[0]) => {
            const rows = (await delegate.findMany(args)) as Account[];
            return rows.map((r) => (r.id === accountId ? { ...r, externalPartnerKey: partnerName } : r));
          };
        },
      });
    },
  }) as typeof testPrisma;
}
