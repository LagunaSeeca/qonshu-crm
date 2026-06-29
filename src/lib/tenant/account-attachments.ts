import type { PrismaClient, AccountAttachment } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { saveFile, readFile, removeFile, removeLeadDir } from "@/lib/files/storage";

const MAX = 10 * 1024 * 1024;
export class FileTooLargeError extends Error {}

export async function addAccountAttachment(db: PrismaClient, user: SessionUser, accountId: string, args: { filename: string; mime: string; bytes: Buffer }): Promise<AccountAttachment> {
  if (args.bytes.length > MAX) throw new FileTooLargeError("file exceeds 10MB");
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  const { diskPath, size } = await saveFile(user.companyId!, `account-${accountId}`, args.filename, args.bytes);
  return db.accountAttachment.create({ data: { companyId: user.companyId!, accountId, filename: args.filename, diskPath, size, mime: args.mime, uploadedById: user.id } });
}

export async function listAccountAttachments(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountAttachment[]> {
  const account = await getAccount(db, user, accountId);
  if (!account) return [];
  return db.accountAttachment.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: { createdAt: "desc" } });
}

export async function getAccountAttachmentForDownload(db: PrismaClient, user: SessionUser, attId: string): Promise<{ att: AccountAttachment; bytes: Buffer } | null> {
  const att = await db.accountAttachment.findFirst({ where: { id: attId, companyId: user.companyId! } });
  if (!att) return null;
  const account = await getAccount(db, user, att.accountId);
  if (!account) return null;
  return { att, bytes: await readFile(att.diskPath) };
}

export async function deleteAccountAttachment(db: PrismaClient, user: SessionUser, attId: string): Promise<void> {
  const att = await db.accountAttachment.findFirst({ where: { id: attId, companyId: user.companyId! } });
  if (!att) throw new NotFoundError("attachment not in tenant");
  const account = await getAccount(db, user, att.accountId);
  if (!account) throw new NotFoundError("account not in scope");
  await removeFile(att.diskPath);
  await db.accountAttachment.delete({ where: { id: attId } });
}

export async function deleteAccountFiles(db: PrismaClient, companyId: string, accountId: string): Promise<void> {
  await removeLeadDir(companyId, `account-${accountId}`);
}
