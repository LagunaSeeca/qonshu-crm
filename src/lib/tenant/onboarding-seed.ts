import type { Prisma } from "@prisma/client";
import { ONBOARDING_TEMPLATE } from "./onboarding-template";

// Copy the fixed post-contract checklist (./onboarding-template.ts) onto an account, EXACTLY ONCE
// in its lifetime.
//
// TAKES A TransactionClient, NOT A PrismaClient, AND THAT IS THE WHOLE DESIGN. The caller MUST
// already be inside a transaction, because the claim below is only atomic with the inserts while
// they share one. Passing a bare client would type-error here, which is the point: a seeded-but-
// empty account (claim committed, inserts lost) is unrecoverable through the UI — the claim makes
// every later attempt a no-op — so the type forbids the shape that produces it.
//
// THE CONCURRENCY ARGUMENT, in full:
//
//  1. The conditional UPDATE (`status: "ACTIVE"`, `onboardingSeededAt: null`) is the CLAIM. It
//     takes a ROW LOCK on the account.
//  2. Under READ COMMITTED (Postgres' default, and this app's) a second transaction running the
//     same statement BLOCKS on that lock. When the first commits, the second re-reads the row,
//     now sees `onboardingSeededAt` non-null, and its WHERE matches 0 rows.
//  3. `count === 0` therefore means "somebody else already seeded this, or it is not ACTIVE" —
//     and the loser inserts nothing. That is why the return value is a boolean and not void: the
//     caller can tell a real seed from a no-op.
//  4. Claim and inserts are in ONE transaction, so a rollback undoes BOTH. There is no state in
//     which the account is marked seeded but has no steps.
//  5. `@@unique([accountId, templateKey])` plus `skipDuplicates` is the SECOND line of defence,
//     under the first: even if a future caller broke rule 1 (two claims in two transactions, or a
//     hand-written insert), the database still cannot hold two rows for one template key.
//
// PRE-EXISTING ACCOUNTS NEVER SEED. The migration backfilled `onboardingSeededAt = createdAt` on
// every account that existed before this feature, so they are already past onboarding and the
// claim's `onboardingSeededAt: null` filters them out — an old AT_RISK account moving back to
// ACTIVE does not suddenly grow a six-step checklist years after it signed.
export async function seedOnboardingChecklist(
  tx: Prisma.TransactionClient,
  account: { id: string; companyId: string },
): Promise<boolean> {
  const claim = await tx.account.updateMany({
    where: { id: account.id, status: "ACTIVE", onboardingSeededAt: null },
    data: { onboardingSeededAt: new Date() },
  });
  if (claim.count === 0) return false;

  await tx.onboardingStep.createMany({
    data: ONBOARDING_TEMPLATE.map((step, i) => ({
      companyId: account.companyId,
      accountId: account.id,
      templateKey: step.key,
      title: step.title,
      // 1-based and in template order: the checklist is read `orderBy: { position: "asc" }`.
      position: i + 1,
    })),
    skipDuplicates: true,
  });
  return true;
}
