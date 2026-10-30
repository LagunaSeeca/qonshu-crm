import type { PrismaClient, PlatformInstallSnapshot } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export async function getAccountInstallSnapshots(db: PrismaClient, user: SessionUser, accountId: string): Promise<PlatformInstallSnapshot[]> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.platformInstallSnapshot.findMany({
    // acc.companyId, not user.companyId: getAccount has already decided the caller may see this
    // account, and a SUPER_ADMIN acting on it has no companyId of its own to filter by.
    where: { companyId: acc.companyId, accountId },
    orderBy: { capturedOn: "asc" },
  });
}

// Manual, LOCAL-only entry — no partner-API call. One row per account per day; editing the
// same day overwrites (create-or-update on the [accountId, capturedOn] unique key).
export async function upsertInstallSnapshot(db: PrismaClient, user: SessionUser, accountId: string, args: {
  capturedOn: Date; iosInstalls: number; androidInstalls: number;
}): Promise<PlatformInstallSnapshot> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.platformInstallSnapshot.upsert({
    where: { accountId_capturedOn: { accountId, capturedOn: args.capturedOn } },
    update: { iosInstalls: args.iosInstalls, androidInstalls: args.androidInstalls, createdById: user.id },
    create: {
      companyId: acc.companyId, accountId, capturedOn: args.capturedOn,
      iosInstalls: args.iosInstalls, androidInstalls: args.androidInstalls, createdById: user.id,
    },
  });
}
