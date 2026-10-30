import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su as toSession } from "@/test/fixtures";
import { createAccount } from "./accounts";
import { addAccountActivity, listAccountActivities } from "./account-activities";
import { addAccountTask, toggleAccountTask, listAccountTasks } from "./account-tasks";
import { addAccountAttachment, listAccountAttachments, getAccountAttachmentForDownload, deleteAccountAttachment } from "./account-attachments";
import { recordPartnerLinkChange } from "./partner-link-audit";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

beforeAll(() => { process.env.UPLOADS_DIR = mkdtempSync(join(tmpdir(), "qonshu-acc-")); });

async function acct(slug: string) {
  const team = await makeTeam({ name: slug });
  const u = await makeUser("MEMBER", team);
  const user: SessionUser = toSession(u);
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

// AccountActivity carries the partner-link audit trail (./partner-link-audit.ts) as well as the
// tenant's own timeline, and the tenant-facing writer takes a free-text outcome AND an arbitrary
// occurredAt — so without a reservation the company being audited could plant rows that read
// exactly like a platform admin's.
describe("the partner_link: outcome prefix is reserved from tenant writers", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("refuses every partner_link: outcome a COMPANY_ADMIN/MEMBER could send, and writes nothing", async () => {
    const A = await acct("a-reserved");
    for (const outcome of ["partner_link:assign", "partner_link:clear", "partner_link:auto_link", "partner_link:"]) {
      await expect(
        addAccountActivity(testPrisma, A.user, A.acc.id, {
          kind: "NOTE", body: "Partner link set to \"Komplex B\" by a platform admin",
          outcome, occurredAt: new Date("2020-01-01"),
        }),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(await testPrisma.accountActivity.count()).toBe(0);
  });

  it("still accepts an ordinary outcome — the reservation is the prefix, not the field", async () => {
    const A = await acct("a-reserved-ok");
    const row = await addAccountActivity(testPrisma, A.user, A.acc.id, {
      kind: "CALL", body: "left a voicemail", outcome: "no answer",
    });
    expect(row.outcome).toBe("no answer");
  });

  // CHANGED ON PURPOSE (teams refactor): the partner-link audit trail no longer lives in
  // AccountActivity — it moved to the durable PartnerLinkAudit table. So a SUPER_ADMIN reading an
  // account's timeline sees the tenant's own rows only, and the audit row is read from its own
  // table. The old assertion (timeline === ["partner_link:assign"]) described the retired storage.
  it("lets a SUPER_ADMIN read a tenant timeline; the audit trail is in PartnerLinkAudit, not in it", async () => {
    const A = await acct("a-su-read");
    await addAccountActivity(testPrisma, A.user, A.acc.id, { kind: "NOTE", body: "tenant note" });
    const admin = await makeUser("SUPER_ADMIN");
    await recordPartnerLinkChange(testPrisma, {
      companyId: A.acc.companyId, accountId: A.acc.id, accountName: A.acc.name, actorId: admin.id,
      action: "assign", partnerName: "Komplex B",
    });
    const su: SessionUser = toSession(admin);
    const rows = await listAccountActivities(testPrisma, su, A.acc.id);
    expect(rows.map((r) => r.body)).toEqual(["tenant note"]);
    expect(rows.every((r) => !r.outcome?.startsWith("partner_link:"))).toBe(true);
    const audit = await testPrisma.partnerLinkAudit.findMany({ where: { accountId: A.acc.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "assign", partnerName: "Komplex B", actorId: admin.id });
    // ...and an account that doesn't exist is an empty list, not a throw.
    expect(await listAccountActivities(testPrisma, su, "no-such-account")).toEqual([]);
  });
});
