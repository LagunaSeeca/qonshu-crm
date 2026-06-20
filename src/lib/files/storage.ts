import { mkdir, writeFile, readFile as fsRead, rm } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const root = () => process.env.UPLOADS_DIR ?? "uploads";

export async function saveFile(companyId: string, leadId: string, filename: string, bytes: Buffer): Promise<{ diskPath: string; size: number }> {
  const dir = join(root(), companyId, leadId);
  await mkdir(dir, { recursive: true });
  const diskPath = join(dir, `${randomUUID()}-${filename}`);
  await writeFile(diskPath, bytes);
  return { diskPath, size: bytes.length };
}
export function readFile(diskPath: string): Promise<Buffer> { return fsRead(diskPath); }
export async function removeFile(diskPath: string): Promise<void> { await rm(diskPath, { force: true }); }
export async function removeLeadDir(companyId: string, leadId: string): Promise<void> { await rm(join(root(), companyId, leadId), { recursive: true, force: true }); }
