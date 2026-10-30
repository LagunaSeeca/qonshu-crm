import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su } from "@/test/fixtures";
import { seedTeamStages, listStages } from "./stages";
import { createLead } from "./leads";
import { addActivity, listActivities } from "./activities";
import type { SessionUser } from "@/lib/auth/guards";

async function lead() {
  const team = await makeTeam();
  const c = { id: team.companyId };
  await seedTeamStages(testPrisma, c.id, team.id);
  const stage = (await listStages(testPrisma, { companyId: c.id, teamId: team.id }))[0];
  const u = await makeUser("MEMBER", team);
  const user: SessionUser = su(u);
  const l = await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: stage.id, companyName: "Bldg" });
  return { user, l };
}

describe("activities", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("adds and lists a note; rejects STAGE_CHANGE", async () => {
    const { user, l } = await lead();
    await addActivity(testPrisma, user, l.id, { kind: "CALL", body: "called", outcome: "interested" });
    const acts = await listActivities(testPrisma, user, l.id);
    expect(acts[0].outcome).toBe("interested");
    await expect(addActivity(testPrisma, user, l.id, { kind: "STAGE_CHANGE" as never, body: "x" })).rejects.toThrow();
  });
});
