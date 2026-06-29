import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { testPrisma, resetDb } from "@/test/db";
import { createAccount } from "./accounts";
import { addAccountActivity, listAccountActivities } from "./account-activities";
import { addAccountTask, toggleAccountTask, listAccountTasks } from "./account-tasks";
import { addAccountAttachment, listAccountAttachments, getAccountAttachmentForDownload, deleteAccountAttachment } from "./account-attachments";
import type { SessionUser } from "@/lib/auth/guards";

beforeAll(() => { process.env.UPLOADS_DIR = mkdtempSync(join(tmpdir(), "qonshu-acc-")); });

async function acct(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "MEMBER" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { user, acc: await createAccount(testPrisma, user, { name: "P" }) };
}

describe("account workspace", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("adds activity, task, toggles task, adds+downloads attachment, cross-tenant download is null", async () => {
    const A = await acct("a-ws");

    // Add activity
    const activity = await addAccountActivity(testPrisma, A.user, A.acc.id, { kind: "MEETING", body: "kickoff sync" });
    expect(activity.kind).toBe("MEETING");
    const acts = await listAccountActivities(testPrisma, A.user, A.acc.id);
    expect(acts.length).toBe(1);

    // Add task
    const task = await addAccountTask(testPrisma, A.user, A.acc.id, { title: "send deck", dueDate: new Date("2026-07-15") });
    expect(task.done).toBe(false);
    const tasks = await listAccountTasks(testPrisma, A.user, A.acc.id);
    expect(tasks.length).toBe(1);

    // Toggle task done
    const toggled = await toggleAccountTask(testPrisma, A.user, task.id, true);
    expect(toggled.done).toBe(true);

    // Add attachment
    const bytes = Buffer.from("attachment-content");
    const att = await addAccountAttachment(testPrisma, A.user, A.acc.id, { filename: "doc.txt", mime: "text/plain", bytes });
    expect(att.size).toBe(bytes.length);
    const atts = await listAccountAttachments(testPrisma, A.user, A.acc.id);
    expect(atts.length).toBe(1);

    // Download attachment and verify bytes
    const dl = await getAccountAttachmentForDownload(testPrisma, A.user, att.id);
    expect(dl?.bytes.toString()).toBe("attachment-content");

    // Cross-tenant download returns null
    const B = await acct("b-ws");
    expect(await getAccountAttachmentForDownload(testPrisma, B.user, att.id)).toBeNull();

    // Delete attachment
    await deleteAccountAttachment(testPrisma, A.user, att.id);
    expect((await listAccountAttachments(testPrisma, A.user, A.acc.id)).length).toBe(0);
  });
});
