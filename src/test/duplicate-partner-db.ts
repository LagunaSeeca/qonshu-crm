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
//
// THE PHANTOM IS A CONFIRMED LINK, so `partnerLinkConfirmedAt` is injected alongside the key. A
// link is now two columns (see src/lib/partner-api/credentials.ts): a key with no stamp is a
// PENDING link that resolves to nothing, and a phantom of that shape would be skipped upstream of
// the dedup as "not_configured" — making this helper quietly stop testing the thing it exists for.
// The row it stands in for is a pre-constraint DUPLICATE that really did serve data.
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
            return rows.map((r) =>
              r.id === accountId
                ? { ...r, externalPartnerKey: partnerName, partnerLinkConfirmedAt: r.partnerLinkConfirmedAt ?? new Date() }
                : r,
            );
          };
        },
      });
    },
  }) as typeof testPrisma;
}
