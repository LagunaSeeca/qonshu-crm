import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Account } from "@prisma/client";
import { resolvePartnerCredentials, resolveGlobalCredentials } from "./credentials";
import { encryptSecret } from "@/lib/crypto/secret";

// Pure-function unit tests for the single chokepoint that decides how an account authenticates
// to the external Partner API — no DB needed, just plain Account-shaped objects. Only the fields
// resolvePartnerCredentials actually reads are set; the rest are irrelevant to this module.
function account(overrides: Partial<Account>): Account {
  return {
    id: "acc_1",
    companyId: "co_1",
    externalPartnerKey: null,
    externalApiKeyEnc: null,
    externalApiKeyLast4: null,
    ...overrides,
  } as Account;
}

const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("resolvePartnerCredentials", () => {
  let savedApiKey: string | undefined;
  let savedSecret: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.PARTNER_API_KEY;
    savedSecret = process.env.PARTNER_API_KEY_SECRET;
    savedBaseUrl = process.env.PARTNER_API_BASE_URL;
    process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
  });
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY; else process.env.PARTNER_API_KEY = savedApiKey;
    if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET; else process.env.PARTNER_API_KEY_SECRET = savedSecret;
    if (savedBaseUrl === undefined) delete process.env.PARTNER_API_BASE_URL; else process.env.PARTNER_API_BASE_URL = savedBaseUrl;
  });

  it("resolves off the shared env key when the account has a partner name and no override column", () => {
    process.env.PARTNER_API_KEY = "shared-env-key";
    process.env.PARTNER_API_BASE_URL = "https://partner.example.com";
    const a = account({ externalPartnerKey: "acme" });

    const creds = resolvePartnerCredentials(a);

    expect(creds).toEqual({ baseUrl: "https://partner.example.com", apiKey: "shared-env-key", partner: "acme" });
  });

  it("a per-account override column wins over the shared env key when both are present", () => {
    process.env.PARTNER_API_KEY = "shared-env-key";
    const a = account({ externalPartnerKey: "acme", externalApiKeyEnc: encryptSecret("override-key") });

    const creds = resolvePartnerCredentials(a);

    expect(creds?.apiKey).toBe("override-key");
    expect(creds?.apiKey).not.toBe("shared-env-key");
    expect(creds?.partner).toBe("acme");
  });

  it("returns null (not configured) when the account has no partner name, even if PARTNER_API_KEY is set", () => {
    process.env.PARTNER_API_KEY = "shared-env-key";
    const a = account({ externalPartnerKey: null });

    expect(resolvePartnerCredentials(a)).toBeNull();
  });

  it("returns null (not configured) when there is a partner name but no resolvable key — no env key and no override", () => {
    delete process.env.PARTNER_API_KEY;
    const a = account({ externalPartnerKey: "acme", externalApiKeyEnc: null });

    expect(resolvePartnerCredentials(a)).toBeNull();
  });

  it("treats an empty-string PARTNER_API_KEY the same as unset (still not configured)", () => {
    process.env.PARTNER_API_KEY = "";
    const a = account({ externalPartnerKey: "acme" });

    expect(resolvePartnerCredentials(a)).toBeNull();
  });

  it("throws (does not silently fall back to the env key) when the override column fails to decrypt", () => {
    const a = account({ externalPartnerKey: "acme", externalApiKeyEnc: "not-a-valid-ciphertext" });
    process.env.PARTNER_API_KEY = "shared-env-key";

    expect(() => resolvePartnerCredentials(a)).toThrow();
  });

  it("passes PARTNER_API_BASE_URL through untouched, including when unset", () => {
    delete process.env.PARTNER_API_BASE_URL;
    process.env.PARTNER_API_KEY = "shared-env-key";
    const a = account({ externalPartnerKey: "acme" });

    expect(resolvePartnerCredentials(a)?.baseUrl).toBeUndefined();
  });
});

// resolveGlobalCredentials backs endpoints that are NOT scoped to a single account's partner
// (the partner-LIST picker) — only the shared env key applies, there is no per-account override
// column to consult since there's no account row at all.
describe("resolveGlobalCredentials", () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.PARTNER_API_KEY;
    savedBaseUrl = process.env.PARTNER_API_BASE_URL;
  });
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY; else process.env.PARTNER_API_KEY = savedApiKey;
    if (savedBaseUrl === undefined) delete process.env.PARTNER_API_BASE_URL; else process.env.PARTNER_API_BASE_URL = savedBaseUrl;
  });

  it("resolves off the shared env key plus base URL when PARTNER_API_KEY is set", () => {
    process.env.PARTNER_API_KEY = "shared-env-key";
    process.env.PARTNER_API_BASE_URL = "https://partner.example.com";

    expect(resolveGlobalCredentials()).toEqual({
      baseUrl: "https://partner.example.com",
      apiKey: "shared-env-key",
    });
  });

  it("returns null (not configured) when PARTNER_API_KEY is unset", () => {
    delete process.env.PARTNER_API_KEY;

    expect(resolveGlobalCredentials()).toBeNull();
  });

  it("treats an empty-string PARTNER_API_KEY the same as unset", () => {
    process.env.PARTNER_API_KEY = "";

    expect(resolveGlobalCredentials()).toBeNull();
  });

  it("passes PARTNER_API_BASE_URL through untouched, including when unset", () => {
    delete process.env.PARTNER_API_BASE_URL;
    process.env.PARTNER_API_KEY = "shared-env-key";

    expect(resolveGlobalCredentials()?.baseUrl).toBeUndefined();
  });
});
