import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
import { encryptSecret } from "@/lib/crypto/secret";
import type { SessionUser } from "@/lib/auth/guards";

// Route handlers use `@/db/client`'s `prisma` singleton (pointed at the real DATABASE_URL) and
// `@/lib/auth/session`'s `getSessionUser` (backed by next-auth/next/headers, which needs a real
// request-scoped context we don't have here). Mock both so the handlers run against testPrisma
// with a session we control, entirely off the network / real DB.
vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { GET as GET_LIST } from "./route";
import { GET as GET_ONE } from "./[id]/route";

const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// There is no per-account Partner API key entry anymore — the external API authenticates every
// partner with one shared X-API-Key read from PARTNER_API_KEY (see
// src/lib/partner-api/credentials.ts); an account goes live purely off its partner NAME. The
// `externalApiKeyEnc`/`externalApiKeyLast4` columns still exist as a dormant override (no
// migration dropped them) and could in principle hold a value if written directly to the DB, so
// these tests just confirm the account routes never let those two columns leak into a response —
// there's no more masked-key feature to test (the `externalApiKeyMasked` field is gone).
describe("account routes — partner key columns never leak", () => {
  let savedSecret: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedSecret = process.env.PARTNER_API_KEY_SECRET;
    process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET;
    else process.env.PARTNER_API_KEY_SECRET = savedSecret;
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  async function seedCompanyAndAdmin(slug: string) {
    const team = await makeTeam({ name: slug });
    const c = { id: team.companyId };
    const u = await makeUser("COMPANY_ADMIN", team);
    mockUser = su(u);
    return { c, u, team };
  }

  it("GET /api/accounts/[id]: strips externalApiKeyEnc/externalApiKeyLast4 even when a dormant override key is set on the row", async () => {
    const slug = `mask-one-${Date.now()}-${Math.random()}`;
    const { c, u, team } = await seedCompanyAndAdmin(slug);
    const plaintext = "sk_live_abcd1234";
    const ciphertext = encryptSecret(plaintext);
    const acc = await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Masked Partner"), name: "Masked Partner", accountManagerId: u.id,
        externalPartnerKey: "partner-x", externalApiKeyEnc: ciphertext, externalApiKeyLast4: "1234",
      },
    });

    const req = new NextRequest(`http://localhost/api/accounts/${acc.id}`);
    const res = await GET_ONE(req, { params: Promise.resolve({ id: acc.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect("externalApiKeyEnc" in body).toBe(false);
    expect("externalApiKeyLast4" in body).toBe(false);
    expect("externalApiKeyMasked" in body).toBe(false); // the per-account key entry/field is gone
    // The partner NAME is withheld from a tenant caller too — see the oracle test below.
    expect("externalPartnerKey" in body).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("partner-x");
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain(ciphertext);
  });

  it("GET /api/accounts/[id]: an account configured by partner name alone (no override column) never mentions a key field", async () => {
    const slug = `mask-none-${Date.now()}-${Math.random()}`;
    const { c, u, team } = await seedCompanyAndAdmin(slug);
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Name Only"), name: "Name Only", accountManagerId: u.id, externalPartnerKey: "partner-only-name" },
    });

    const req = new NextRequest(`http://localhost/api/accounts/${acc.id}`);
    const res = await GET_ONE(req, { params: Promise.resolve({ id: acc.id }) });
    const body = await res.json();

    expect("externalPartnerKey" in body).toBe(false);
    expect("externalApiKeyEnc" in body).toBe(false);
    expect("externalApiKeyLast4" in body).toBe(false);
    expect("externalApiKeyMasked" in body).toBe(false);
  });

  // THE PARTNER NAME IS AN ANSWER, NOT A SECRET.
  //
  // Auto-link resolves a new account's name against the LIVE upstream list, so echoing the
  // resolved key back meant the response confirmed "a complex by this name exists upstream" over a
  // namespace shared by every company on the platform — and a COMPANY_ADMIN can DELETE the probe
  // account and ask again, leaving no residue. The link itself is unchanged; what is gone is the
  // reply that scored the guess. The owner, who assigns these links, still sees it.
  //
  // (Nothing in the UI regresses: the account page renders the field from the server-side row, not
  // from an API response.)
  it("GET /api/accounts/[id]: the partner name is withheld from a tenant caller and returned to the owner", async () => {
    const slug = `mask-oracle-${Date.now()}-${Math.random()}`;
    const { c, u, team } = await seedCompanyAndAdmin(slug);
    const acc = await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Oracle"), name: "Oracle",
        accountManagerId: u.id, externalPartnerKey: "Komplex B",
      },
    });
    const get = async () => {
      const res = await GET_ONE(new NextRequest(`http://localhost/api/accounts/${acc.id}`), {
        params: Promise.resolve({ id: acc.id }),
      });
      expect(res.status).toBe(200);
      return res.json();
    };

    // The team admin who owns the account in the CRM sense: no answer.
    const adminBody = await get();
    expect("externalPartnerKey" in adminBody).toBe(false);
    expect(JSON.stringify(adminBody)).not.toContain("Komplex B");

    // A MEMBER managing it: no answer either.
    const member = await makeUser("MEMBER", team);
    await testPrisma.account.update({ where: { id: acc.id }, data: { accountManagerId: member.id } });
    mockUser = su(member);
    expect("externalPartnerKey" in (await get())).toBe(false);

    // The SUPER_ADMIN, acting inside the company, still sees the link it is theirs to assign.
    const owner = await makeUser("SUPER_ADMIN");
    mockUser = su(await testPrisma.user.update({ where: { id: owner.id }, data: { companyId: c.id } }));
    expect((await get()).externalPartnerKey).toBe("Komplex B");
  });

  it("GET /api/accounts (list): strips the columns from every row", async () => {
    const slug = `mask-list-${Date.now()}-${Math.random()}`;
    const { c, u, team } = await seedCompanyAndAdmin(slug);
    const plaintext = "sk_live_zzzz9999";
    const ciphertext = encryptSecret(plaintext);
    await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Configured"), name: "Configured", accountManagerId: u.id,
        externalPartnerKey: "partner-y", externalApiKeyEnc: ciphertext, externalApiKeyLast4: "9999",
      },
    });
    await testPrisma.account.create({
      data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Unconfigured"), name: "Unconfigured", accountManagerId: u.id },
    });

    const req = new NextRequest("http://localhost/api/accounts");
    const res = await GET_LIST(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(2);
    for (const row of body) {
      expect("externalApiKeyEnc" in row).toBe(false);
      expect("externalApiKeyLast4" in row).toBe(false);
      expect("externalApiKeyMasked" in row).toBe(false);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain(ciphertext);
  });

  it("GET /api/accounts/[id]: a foreign (cross-tenant) account 404s instead of leaking anything", async () => {
    const slugA = `mask-x1-${Date.now()}-${Math.random()}`;
    const slugB = `mask-x2-${Date.now()}-${Math.random()}`;
    const { c: cB, u: uB, team: teamB } = await seedCompanyAndAdmin(slugB);
    const foreignAcc = await testPrisma.account.create({
      data: {
        companyId: cB.id, teamId: teamB.id, buildingKey: buildingKey("Foreign"), name: "Foreign", accountManagerId: uB.id,
        externalPartnerKey: "partner-z", externalApiKeyEnc: encryptSecret("other-tenant-key"), externalApiKeyLast4: "9999",
      },
    });
    await seedCompanyAndAdmin(slugA); // switches mockUser to company A

    const req = new NextRequest(`http://localhost/api/accounts/${foreignAcc.id}`);
    const res = await GET_ONE(req, { params: Promise.resolve({ id: foreignAcc.id }) });
    expect(res.status).toBe(404);
  });
});
