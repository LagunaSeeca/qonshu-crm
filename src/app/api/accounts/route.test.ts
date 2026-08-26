import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
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

describe("account routes — API key masking", () => {
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
    const c = await testPrisma.company.create({ data: { name: "Co", slug } });
    const u = await testPrisma.user.create({
      data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" },
    });
    mockUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    return { c, u };
  }

  it("GET /api/accounts/[id]: masks a configured key as ••••<last4> and strips the ciphertext/last4 fields", async () => {
    const slug = `mask-one-${Date.now()}-${Math.random()}`;
    const { c, u } = await seedCompanyAndAdmin(slug);
    const plaintext = "sk_live_abcd1234";
    const ciphertext = encryptSecret(plaintext);
    const acc = await testPrisma.account.create({
      data: {
        companyId: c.id, name: "Masked Partner", accountManagerId: u.id,
        externalPartnerKey: "partner-x", externalApiKeyEnc: ciphertext, externalApiKeyLast4: "1234",
      },
    });

    const req = new NextRequest(`http://localhost/api/accounts/${acc.id}`);
    const res = await GET_ONE(req, { params: Promise.resolve({ id: acc.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.externalApiKeyMasked).toBe("••••1234");
    expect(body.externalApiKeyEnc).toBeUndefined();
    expect(body.externalApiKeyLast4).toBeUndefined();
    expect("externalApiKeyEnc" in body).toBe(false);
    expect("externalApiKeyLast4" in body).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain(ciphertext);
  });

  it("GET /api/accounts/[id]: an unconfigured account gets externalApiKeyMasked: null", async () => {
    const slug = `mask-none-${Date.now()}-${Math.random()}`;
    const { c, u } = await seedCompanyAndAdmin(slug);
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, name: "No Key", accountManagerId: u.id },
    });

    const req = new NextRequest(`http://localhost/api/accounts/${acc.id}`);
    const res = await GET_ONE(req, { params: Promise.resolve({ id: acc.id }) });
    const body = await res.json();

    expect(body.externalApiKeyMasked).toBeNull();
    expect("externalApiKeyEnc" in body).toBe(false);
    expect("externalApiKeyLast4" in body).toBe(false);
  });

  it("GET /api/accounts (list): masks every row's key the same way", async () => {
    const slug = `mask-list-${Date.now()}-${Math.random()}`;
    const { c, u } = await seedCompanyAndAdmin(slug);
    const plaintext = "sk_live_zzzz9999";
    const ciphertext = encryptSecret(plaintext);
    await testPrisma.account.create({
      data: {
        companyId: c.id, name: "Configured", accountManagerId: u.id,
        externalPartnerKey: "partner-y", externalApiKeyEnc: ciphertext, externalApiKeyLast4: "9999",
      },
    });
    await testPrisma.account.create({
      data: { companyId: c.id, name: "Unconfigured", accountManagerId: u.id },
    });

    const req = new NextRequest("http://localhost/api/accounts");
    const res = await GET_LIST(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(2);
    const configured = body.find((a: { name: string }) => a.name === "Configured");
    const unconfigured = body.find((a: { name: string }) => a.name === "Unconfigured");
    expect(configured.externalApiKeyMasked).toBe("••••9999");
    expect(unconfigured.externalApiKeyMasked).toBeNull();
    for (const row of body) {
      expect("externalApiKeyEnc" in row).toBe(false);
      expect("externalApiKeyLast4" in row).toBe(false);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain(ciphertext);
  });

  it("GET /api/accounts/[id]: a foreign (cross-tenant) account 404s instead of leaking its masked key", async () => {
    const slugA = `mask-x1-${Date.now()}-${Math.random()}`;
    const slugB = `mask-x2-${Date.now()}-${Math.random()}`;
    const { c: cB, u: uB } = await seedCompanyAndAdmin(slugB);
    const foreignAcc = await testPrisma.account.create({
      data: {
        companyId: cB.id, name: "Foreign", accountManagerId: uB.id,
        externalPartnerKey: "partner-z", externalApiKeyEnc: encryptSecret("other-tenant-key"), externalApiKeyLast4: "9999",
      },
    });
    await seedCompanyAndAdmin(slugA); // switches mockUser to company A

    const req = new NextRequest(`http://localhost/api/accounts/${foreignAcc.id}`);
    const res = await GET_ONE(req, { params: Promise.resolve({ id: foreignAcc.id }) });
    expect(res.status).toBe(404);
  });
});
