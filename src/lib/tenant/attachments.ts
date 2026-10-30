import type { PrismaClient, Attachment } from "@prisma/client";
import { NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { leadScopeWhere } from "./scope";
import { getLead } from "./leads";
import { saveFile, readFile, removeFile, removeLeadDir } from "@/lib/files/storage";

const MAX = 10 * 1024 * 1024;
export class FileTooLargeError extends Error {}

// Throughout this module the tenant comes from the LEAD (or, for the two attachment-first
// lookups, from the caller's scope) rather than from `user.companyId!`. Same reason as in
// activities.ts: the lead is the row that owns the file, getLead has already proved it is in
// scope, and the non-null assertion hid the fact that a SUPER_ADMIN has no companyId.
export async function addAttachment(
  db: PrismaClient, user: SessionUser, leadId: string,
  args: { filename: string; mime: string; bytes: Buffer },
): Promise<Attachment> {
  if (args.bytes.length > MAX) throw new FileTooLargeError("file exceeds 10MB");
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  const { diskPath, size } = await saveFile(lead.companyId, leadId, args.filename, args.bytes);
  return db.attachment.create({
    data: {
      companyId: lead.companyId, leadId, filename: args.filename, diskPath, size,
      mime: args.mime, uploadedById: user.id,
    },
  });
}

export async function listAttachments(db: PrismaClient, user: SessionUser, leadId: string): Promise<Attachment[]> {
  const lead = await getLead(db, user, leadId);
  if (!lead) return [];
  return db.attachment.findMany({ where: { companyId: lead.companyId, leadId }, orderBy: { createdAt: "desc" } });
}

export async function getAttachmentForDownload(
  db: PrismaClient, user: SessionUser, attId: string,
): Promise<{ att: Attachment; bytes: Buffer } | null> {
  const { companyId } = leadScopeWhere(user);
  const att = await db.attachment.findFirst({ where: { id: attId, companyId } });
  if (!att) return null;
  // The company check above is not enough on its own: the lead lookup is what applies the team
  // and own-rows-only rules, so a member cannot download another team's files.
  const lead = await getLead(db, user, att.leadId);
  if (!lead) return null;
  return { att, bytes: await readFile(att.diskPath) };
}

export async function deleteAttachment(db: PrismaClient, user: SessionUser, attId: string): Promise<void> {
  const { companyId } = leadScopeWhere(user);
  const att = await db.attachment.findFirst({ where: { id: attId, companyId } });
  if (!att) throw new NotFoundError("attachment not in tenant");
  const lead = await getLead(db, user, att.leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  await removeFile(att.diskPath);
  await db.attachment.delete({ where: { id: attId } });
}

export async function deleteLeadFiles(db: PrismaClient, companyId: string, leadId: string): Promise<void> {
  await removeLeadDir(companyId, leadId);
}
