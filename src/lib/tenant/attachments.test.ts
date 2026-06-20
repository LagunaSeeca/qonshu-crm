import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { addAttachment, listAttachments, getAttachmentForDownload } from "./attachments";
import type { SessionUser } from "@/lib/auth/guards";

beforeAll(() => { process.env.UPLOADS_DIR = mkdtempSync(join(tmpdir(), "qonshu-up-")); });

async function lead() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-at" } });
  await seedDefaultStages(testPrisma, c.id);
  const stage = (await listStages(testPrisma, { companyId: c.id }))[0];
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { user, l: await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: stage.id }) };
}

describe("attachments", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("uploads, lists, downloads bytes back", async () => {
    const { user, l } = await lead();
    const bytes = Buffer.from("hello-file");
    const att = await addAttachment(testPrisma, user, l.id, { filename: "a.txt", mime: "text/plain", bytes });
    expect(att.size).toBe(bytes.length);
    expect((await listAttachments(testPrisma, user, l.id)).length).toBe(1);
    const dl = await getAttachmentForDownload(testPrisma, user, att.id);
    expect(dl?.bytes.toString()).toBe("hello-file");
  });

  it("rejects files over 10MB", async () => {
    const { user, l } = await lead();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(addAttachment(testPrisma, user, l.id, { filename: "big.bin", mime: "application/octet-stream", bytes: big })).rejects.toThrow();
  });
});
