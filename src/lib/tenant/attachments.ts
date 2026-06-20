import type { PrismaClient, Attachment } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { getLead } from "./leads";
import { saveFile, readFile, removeFile, removeLeadDir } from "@/lib/files/storage";

const MAX = 10 * 1024 * 1024;
export class FileTooLargeError extends Error {}

export async function addAttachment(db: PrismaClient, user: SessionUser, leadId: string, args: { filename: string; mime: string; bytes: Buffer }): Promise<Attachment> {
  if (args.bytes.length > MAX) throw new FileTooLargeError("file exceeds 10MB");
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new Error("lead not in scope");
  const { diskPath, size } = await saveFile(user.companyId!, leadId, args.filename, args.bytes);
  return db.attachment.create({ data: { companyId: user.companyId!, leadId, filename: args.filename, diskPath, size, mime: args.mime, uploadedById: user.id } });
}

export async function listAttachments(db: PrismaClient, user: SessionUser, leadId: string): Promise<Attachment[]> {
  const lead = await getLead(db, user, leadId);
  if (!lead) return [];
  return db.attachment.findMany({ where: { companyId: user.companyId!, leadId }, orderBy: { createdAt: "desc" } });
}

export async function getAttachmentForDownload(db: PrismaClient, user: SessionUser, attId: string): Promise<{ att: Attachment; bytes: Buffer } | null> {
  const att = await db.attachment.findFirst({ where: { id: attId, companyId: user.companyId! } });
  if (!att) return null;
  const lead = await getLead(db, user, att.leadId);
  if (!lead) return null;
  return { att, bytes: await readFile(att.diskPath) };
}

export async function deleteAttachment(db: PrismaClient, user: SessionUser, attId: string): Promise<void> {
  const att = await db.attachment.findFirst({ where: { id: attId, companyId: user.companyId! } });
  if (!att) throw new Error("attachment not in tenant");
  const lead = await getLead(db, user, att.leadId);
  if (!lead) throw new Error("lead not in scope");
  await removeFile(att.diskPath);
  await db.attachment.delete({ where: { id: attId } });
}

export async function deleteLeadFiles(db: PrismaClient, companyId: string, leadId: string): Promise<void> {
  await removeLeadDir(companyId, leadId);
}
