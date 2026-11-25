import type { PrismaClient, AccountAttachment } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { assertCan, NotFoundError } from "@/lib/auth/guards";
import { getAccount, getWritableAccount } from "./accounts";
import { saveFile, readFile, removeFile } from "@/lib/files/storage";

// ATTACHMENTS COUNT AS FINANCIAL DATA, by the product owner's decision: what actually lives in an
// account's Files tab is the signed contract, and a signed contract states prices. There is no way
// to tell a contract from a floor plan from a filename or a mime type, so the whole tab is treated
// as the most sensitive thing in it.
//
// So READS (list, and the download path) require `view_financials` — every role but ONBOARDING,
// MEMBER emphatically included and unchanged. WRITES go through getWritableAccount
// (`edit_accounts`), so an assigned onboarding user can neither upload into nor delete from a
// building's file store.
//
// Gated in the SERVICE, not the route: server components call these directly and pass the rows into
// the client bundle. Hiding the Files TAB is a separate UI task and is not what stops the data.
const MAX = 10 * 1024 * 1024;
export class FileTooLargeError extends Error {}

export async function addAccountAttachment(db: PrismaClient, user: SessionUser, accountId: string, args: { filename: string; mime: string; bytes: Buffer }): Promise<AccountAttachment> {
  if (args.bytes.length > MAX) throw new FileTooLargeError("file exceeds 10MB");
  const account = await getWritableAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  const { diskPath, size } = await saveFile(user.companyId!, `account-${accountId}`, args.filename, args.bytes);
  return db.accountAttachment.create({ data: { companyId: user.companyId!, accountId, filename: args.filename, diskPath, size, mime: args.mime, uploadedById: user.id } });
}

export async function listAccountAttachments(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountAttachment[]> {
  // Before the scope lookup: id-independent, so the refusal discloses nothing about the id.
  assertCan(user, "view_financials");
  const account = await getAccount(db, user, accountId);
  if (!account) return [];
  return db.accountAttachment.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: { createdAt: "desc" } });
}

export async function getAccountAttachmentForDownload(db: PrismaClient, user: SessionUser, attId: string): Promise<{ att: AccountAttachment; bytes: Buffer } | null> {
  // The BYTES are the contract. Gated before the attachment row is even looked up, so there is no
  // "403 for a real file id, null for an invented one" distinction to probe with.
  assertCan(user, "view_financials");
  const att = await db.accountAttachment.findFirst({ where: { id: attId, companyId: user.companyId! } });
  if (!att) return null;
  const account = await getAccount(db, user, att.accountId);
  if (!account) return null;
  return { att, bytes: await readFile(att.diskPath) };
}

export async function deleteAccountAttachment(db: PrismaClient, user: SessionUser, attId: string): Promise<void> {
  // Hoisted above the child lookup (same reasoning as account-tasks.ts): getWritableAccount
  // asserts it again as the chokepoint, but only once a row has been found.
  assertCan(user, "edit_accounts");
  const att = await db.accountAttachment.findFirst({ where: { id: attId, companyId: user.companyId! } });
  if (!att) throw new NotFoundError("attachment not in tenant");
  const account = await getWritableAccount(db, user, att.accountId);
  if (!account) throw new NotFoundError("account not in scope");
  await removeFile(att.diskPath);
  await db.accountAttachment.delete({ where: { id: attId } });
}
