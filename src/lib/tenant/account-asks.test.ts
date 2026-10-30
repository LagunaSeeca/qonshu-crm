import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su } from "@/test/fixtures";
import { createAccount } from "./accounts";
import { addAsk, listAsks, resolveAsk, reopenAsk } from "./account-asks";
import type { SessionUser } from "@/lib/auth/guards";

async function acct() {
  const team = await makeTeam();
  const u = await makeUser("MEMBER", team);
  const user: SessionUser = su(u);
  return { user, acc: await createAccount(testPrisma, user, { name: "P" }) };
}

describe("account asks", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates OPEN, resolves, reopens", async () => {
    const { user, acc } = await acct();
    const ask = await addAsk(testPrisma, user, acc.id, { title: "need API key", detail: "prod" });
    expect(ask.status).toBe("OPEN");
    const resolved = await resolveAsk(testPrisma, user, ask.id);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = await reopenAsk(testPrisma, user, ask.id);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.resolvedAt).toBeNull();
    expect((await listAsks(testPrisma, user, acc.id)).length).toBe(1);
  });
});
