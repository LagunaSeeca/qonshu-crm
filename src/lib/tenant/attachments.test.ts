import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su } from "@/test/fixtures";
import { seedTeamStages, listStages } from "./stages";
import { createLead } from "./leads";
import { addAttachment, listAttachments, getAttachmentForDownload } from "./attachments";
import type { SessionUser } from "@/lib/auth/guards";

beforeAll(() => { process.env.UPLOADS_DIR = mkdtempSync(join(tmpdir(), "qonshu-up-")); });

async function lead() {
  const team = await makeTeam();
  const c = { id: team.companyId };
  await seedTeamStages(testPrisma, c.id, team.id);
  const stage = (await listStages(testPrisma, { companyId: c.id, teamId: team.id }))[0];
  const u = await makeUser("MEMBER", team);
  const user: SessionUser = su(u);
  return { user, l: await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: stage.id, companyName: "Bldg" }) };
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

  it("denies cross-tenant download", async () => {
    const A = await lead();
    const bytes = Buffer.from("secret");
    const att = await addAttachment(testPrisma, A.user, A.l.id, { filename: "s.txt", mime: "text/plain", bytes });
    const u2 = await makeUser("MEMBER", await makeTeam());
    const other = su(u2);
    expect(await getAttachmentForDownload(testPrisma, other, att.id)).toBeNull();
  });
});
