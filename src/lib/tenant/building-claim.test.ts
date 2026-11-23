import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { StageType } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { buildingKey, makeTeamWithUsers, makeUser } from "@/test/fixtures";
import { su } from "@/test/fixtures";
import { listStages, seedTeamStages } from "./stages";
import { assertBuildingUnclaimed, BuildingClaimedError, normalizeBuildingName, type ClaimArgs } from "./building-claim";

// ONE BUILDING, ONE RECORD, ORG-WIDE. building-claim.ts is the module four separate tasks in
// this refactor build on (createLead, updateLead, the Won auto-convert, and the account path)
// and it shipped with no tests at all. These are those tests.

// The guard REQUIRES a transaction client: pg_advisory_xact_lock is held only until the
// transaction that took it ends, so a guard that ran in its own implicit transaction would
// release the lock before the caller ever wrote. It throws outright if handed a full
// PrismaClient — which is why every call in this file goes through a real $transaction.
function guard(args: ClaimArgs): Promise<void> {
  return testPrisma.$transaction((tx) => assertBuildingUnclaimed(tx, args));
}

async function teamFixture(companyId?: string) {
  const t = await makeTeamWithUsers(companyId ? { companyId } : {});
  await seedTeamStages(testPrisma, t.companyId, t.team.id);
  const stages = await listStages(testPrisma, { companyId: t.companyId, teamId: t.team.id });
  return { ...t, stages };
}
type Fixture = Awaited<ReturnType<typeof teamFixture>>;

// A raw lead create on purpose: these tests exercise the GUARD, so the holder row has to exist
// without going through createLead (which calls the guard itself).
async function holdBuilding(
  t: Fixture, name: string,
  opts: { type?: StageType; ownerId?: string; title?: string; contactName?: string } = {},
) {
  const stage = t.stages.find((s) => s.type === (opts.type ?? "OPEN"))!;
  return testPrisma.lead.create({
    data: {
      companyId: t.companyId, teamId: t.team.id, ownerId: opts.ownerId ?? t.member.id,
      buildingKey: buildingKey(name), companyName: name,
      title: opts.title ?? name, contactName: opts.contactName ?? "Contact",
      stageId: stage.id,
    },
  });
}

describe("building claim", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("rejects a second claim on the same building in the same company", async () => {
    const t = await teamFixture();
    await holdBuilding(t, "Sabah City");
    await expect(
      guard({ companyId: t.companyId, key: buildingKey("Sabah City"), user: t.suMember, name: "Sabah City" }),
    ).rejects.toThrow(BuildingClaimedError);
  });

  it("allows the same building name in a different company", async () => {
    const a = await teamFixture();
    const b = await teamFixture();
    await holdBuilding(a, "Sabah City");
    // Claims are per company (the unique index is `[companyId, buildingKey]`), and naming
    // another tenant's holder in a message would leak their staff — so this is simply free.
    await expect(
      guard({ companyId: b.companyId, key: buildingKey("Sabah City"), user: b.suMember, name: "Sabah City" }),
    ).resolves.toBeUndefined();
  });

  it("collides case, whitespace and Azerbaijani İ variants onto one claim", async () => {
    const t = await teamFixture();
    const canonical = "İŞIQ Residence";
    await holdBuilding(t, canonical);
    const variants = [
      canonical,
      "işiq residence",
      "İŞIQ RESIDENCE",
      "  İŞIQ   Residence  ",
      "İŞIQ\tResidence",
      "İŞIQ\nResidence",
      // "i" + U+0307 COMBINING DOT ABOVE: exactly what `"İ".toLowerCase()` produces in JS,
      // where Postgres `lower()` produces a bare "i". The U+0307 strip is the only reason this
      // spelling lands on the same key as the rows the migration's backfill wrote.
      "i̇şiq residence",
    ];
    for (const variant of variants) {
      // Byte-identical to src/test/fixtures.ts's buildingKey(), which mirrors the migration's
      // backfill. If these two ever drift, the app computes keys the database's own rows could
      // never match and every Azerbaijani building becomes claimable twice.
      expect(normalizeBuildingName(variant)).toBe(buildingKey(canonical));
      await expect(
        guard({ companyId: t.companyId, key: normalizeBuildingName(variant), user: t.suMember, name: variant }),
      ).rejects.toThrow(BuildingClaimedError);
    }
  });

  it("still blocks when the holder is a LOST lead", async () => {
    const t = await teamFixture();
    // OWNER DECISION: a lost lead KEEPS its claim until someone reassigns it, which is why the
    // index is a plain unique and deliberately not stage-aware. A second team walking into a
    // complex a colleague just lost must be told, not handed a duplicate.
    await holdBuilding(t, "Lost Tower", { type: "LOST" });
    await expect(
      guard({ companyId: t.companyId, key: buildingKey("Lost Tower"), user: t.suMember, name: "Lost Tower" }),
    ).rejects.toThrow(BuildingClaimedError);
  });

  it("exceptLeadId lets a record keep its own key", async () => {
    const t = await teamFixture();
    const lead = await holdBuilding(t, "Own Key Plaza");
    const args = { companyId: t.companyId, key: buildingKey("Own Key Plaza"), user: t.suMember, name: "Own Key Plaza" };
    // Re-saving a lead without really changing its building (a different spelling, the same
    // normalized key) must not report the lead against itself.
    await expect(guard({ ...args, exceptLeadId: lead.id })).resolves.toBeUndefined();
    // Same key, no exception: a clash again, so the exception is what did the work above.
    await expect(guard(args)).rejects.toThrow(BuildingClaimedError);
  });

  it("serialises two concurrent claims on one key — exactly one wins", async () => {
    const t = await teamFixture();
    const name = "Race Residence";
    const key = buildingKey(name);
    const stageId = t.stages[0].id;
    const attempt = (title: string) =>
      testPrisma.$transaction(async (tx) => {
        await assertBuildingUnclaimed(tx, { companyId: t.companyId, key, user: t.suMember, name });
        return tx.lead.create({
          data: {
            companyId: t.companyId, teamId: t.team.id, ownerId: t.member.id,
            buildingKey: key, companyName: name, title, contactName: "C", stageId,
          },
        });
      });

    const results = await Promise.allSettled([attempt("first"), attempt("second")]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.length).toBe(1);
    // THE POINT OF THE ADVISORY LOCK: the loser is stopped by the GUARD. A raw P2002 here would
    // mean the lock serialised nothing, both transactions read "free", and the only thing that
    // caught the duplicate was the unique index — which cannot catch the lead-vs-account case
    // at all, because those are two tables with two separate indexes.
    expect(rejected[0].reason).toBeInstanceOf(BuildingClaimedError);
    expect(await testPrisma.lead.count({ where: { companyId: t.companyId, buildingKey: key } })).toBe(1);
  });

  it("tells a MEMBER only the holder's name and team, nothing from inside the record", async () => {
    const held = await teamFixture();
    // Same company, a different team: the asker is a stranger to this record and cannot open it.
    const asker = await teamFixture(held.companyId);
    const holder = await makeUser("MEMBER", held.team, { name: "Leyla Holder" });
    const lead = await holdBuilding(held, "Qonshu Qala", {
      ownerId: holder.id, title: "SECRET-TITLE", contactName: "SECRET-CONTACT",
    });

    const err = await guard({
      companyId: held.companyId, key: buildingKey("Qonshu Qala"), user: asker.suMember, name: "Qonshu Qala",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BuildingClaimedError);
    const claimed = err as BuildingClaimedError;
    // Whom to talk to — that is the whole purpose of the message.
    expect(claimed.message).toContain("Leyla Holder");
    expect(claimed.message).toContain(held.team.name);
    // And nothing else. No link, no id, nothing from inside a record they cannot open.
    expect(claimed.message).not.toContain("/crm/");
    expect(claimed.message).not.toContain(lead.id);
    expect(claimed.message).not.toContain("SECRET-TITLE");
    expect(claimed.message).not.toContain("SECRET-CONTACT");
    // The structured fields stay available server-side, for logging and for callers that render
    // their own copy — they are just never put on the wire (see errorResponse in http.ts).
    expect(claimed.recordKind).toBe("lead");
    expect(claimed.recordId).toBe(lead.id);
    expect(claimed.isSelf).toBe(false);

    // Contrast: the HOLDER gets the link, because the record is already in their scope and the
    // next step is to open it.
    const own = await guard({
      companyId: held.companyId, key: buildingKey("Qonshu Qala"), user: su(holder), name: "Qonshu Qala",
    }).catch((e: unknown) => e as BuildingClaimedError);
    expect((own as BuildingClaimedError).isSelf).toBe(true);
    expect((own as BuildingClaimedError).message).toContain(`/crm/${lead.id}`);
  });
});
