import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPartnerStats, fetchPartnerObjects } from "./client";
import {
  InvalidApiKeyError,
  UnknownPartnerError,
  PartnerApiUnavailableError,
} from "./errors";
import type { PartnerStatsResponse, PartnerObjectsResponse } from "./schema";

const BASE_URL = "https://partner.example.com";
const API_KEY = "super-secret-key-value-9f3a";

function validStats(overrides: Partial<PartnerStatsResponse> = {}): PartnerStatsResponse {
  return {
    partner: "acme",
    date_from: "2026-01-01",
    date_to: "2026-01-31",
    total_users: 100,
    active_users: 80,
    engaged_users: 60,
    total_debt: 1234.5,
    total_installations: 90,
    ios_installations: 40,
    android_installations: 50,
    logged_in_users: 70,
    total_payments_count: 12,
    total_payments_amount: 4200,
    amount_by_card: 3000,
    amount_by_manual: 700,
    amount_by_cash: 500,
    utility_payments_count: 3,
    utility_payments_amount: 300,
    apartment_payments_amount: 2000,
    parking_payments_amount: 500,
    property_payments_amount: 900,
    office_payments_amount: 800,
    payments: [
      {
        id: "p1",
        user_id: "u1",
        user_name: "Jane",
        date: "2026-01-05",
        amount: 100,
        method: "CARD",
        category: "APARTMENT",
      },
    ],
    payments_page: 1,
    payments_page_count: 1,
    payments_total_count: 1,
    ...overrides,
  };
}

function validObjects(): PartnerObjectsResponse {
  return {
    partner: "acme",
    complex_type: "RESIDENTIAL",
    buildings: [
      {
        id: 1,
        name: "Building A",
        blocks: [
          {
            id: 10,
            name: "Block 1",
            apartments: [
              {
                id: 100,
                owner_id: 5,
                owner_name: "Jane",
                owner_mobile: "+100",
                debt: 50,
                balance: 10,
                net: -40,
                apartment_number: "12B",
              },
            ],
          },
        ],
        parkings: [
          {
            id: 200,
            owner_id: null,
            owner_name: null,
            owner_mobile: null,
            debt: 0,
            balance: 0,
            net: 0,
            parking_number: "P-7",
          },
        ],
        properties: [
          {
            id: 300,
            owner_id: 9,
            owner_name: "Acme LLC",
            owner_mobile: null,
            debt: 5,
            balance: 0,
            net: -5,
            property_number: "R-1",
            type: "SHOP",
          },
        ],
        offices: [
          {
            id: 400,
            owner_id: 9,
            owner_name: "Acme LLC",
            owner_mobile: "+200",
            debt: 0,
            balance: 100,
            net: 100,
            office_number: "O-2",
          },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The last URL + init the stubbed fetch was called with, for assertions.
function lastCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = mock.mock.calls.at(-1)!;
  return { url: url as string, init: init as RequestInit };
}

let fetchMock: ReturnType<typeof vi.fn>;

describe("partner-api client", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PARTNER_API_BASE_URL;
  });

  describe("fetchPartnerStats", () => {
    it("hits the stats path with the query params and X-API-Key header", async () => {
      fetchMock.mockResolvedValue(jsonResponse(validStats()));
      const out = await fetchPartnerStats({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        partner: "acme",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      expect(out.partner).toBe("acme");
      expect(out.payments[0].method).toBe("CARD");

      const { url, init } = lastCall(fetchMock);
      expect(url).toContain(`${BASE_URL}/api/qonshu/partner-stats/`);
      expect(url).toContain("partner=acme");
      expect(url).toContain("date_from=2026-01-01");
      expect(url).toContain("date_to=2026-01-31");
      expect(url).toContain("page=1"); // default
      expect(url).toContain("page_size=100"); // default
      expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
      // the key must never appear in the URL
      expect(url).not.toContain(API_KEY);
    });

    it("caps page_size at 500 and floors page at 1", async () => {
      fetchMock.mockResolvedValue(jsonResponse(validStats()));
      await fetchPartnerStats({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        partner: "acme",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        page: 0,
        pageSize: 9999,
      });
      const { url } = lastCall(fetchMock);
      expect(url).toContain("page=1");
      expect(url).toContain("page_size=500");
    });

    it("uses PARTNER_API_BASE_URL when no baseUrl is passed", async () => {
      process.env.PARTNER_API_BASE_URL = "https://env.example.com/";
      fetchMock.mockResolvedValue(jsonResponse(validStats()));
      await fetchPartnerStats({
        apiKey: API_KEY,
        partner: "acme",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      });
      const { url } = lastCall(fetchMock);
      // trailing slash trimmed, no double slash before the path
      expect(url).toContain("https://env.example.com/api/qonshu/partner-stats/");
    });

    it("maps 401 → InvalidApiKeyError without leaking the key", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: "no" }, 401));
      const err = await fetchPartnerStats({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        partner: "acme",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidApiKeyError);
      expect(err.message).not.toContain(API_KEY);
    });

    it("maps 404 → UnknownPartnerError", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: "no" }, 404));
      await expect(
        fetchPartnerStats({
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          partner: "ghost",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
        }),
      ).rejects.toBeInstanceOf(UnknownPartnerError);
    });

    it("maps 500 → PartnerApiUnavailableError", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
      await expect(
        fetchPartnerStats({
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          partner: "acme",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
        }),
      ).rejects.toBeInstanceOf(PartnerApiUnavailableError);
    });

    it("maps a network error → PartnerApiUnavailableError and keeps the key out of the message", async () => {
      fetchMock.mockRejectedValue(new Error(`socket to ${API_KEY} died`));
      const err = await fetchPartnerStats({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        partner: "acme",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(PartnerApiUnavailableError);
      expect(err.message).not.toContain(API_KEY); // our message is static, not the cause's
    });

    it("times out via AbortController → PartnerApiUnavailableError", async () => {
      // fetch that never resolves until aborted
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      await expect(
        fetchPartnerStats({
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          partner: "acme",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
          timeoutMs: 5,
        }),
      ).rejects.toBeInstanceOf(PartnerApiUnavailableError);
    });

    it("throws when the response shape is invalid (zod)", async () => {
      fetchMock.mockResolvedValue(jsonResponse(validStats({ total_users: "lots" as unknown as number })));
      await expect(
        fetchPartnerStats({
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          partner: "acme",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
        }),
      ).rejects.toThrow();
    });
  });

  describe("fetchPartnerObjects", () => {
    it("hits the objects path with partner query + auth header and parses the tree", async () => {
      fetchMock.mockResolvedValue(jsonResponse(validObjects()));
      const out = await fetchPartnerObjects({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        partner: "acme",
      });
      expect(out.complex_type).toBe("RESIDENTIAL");
      expect(out.buildings[0].blocks[0].apartments[0].apartment_number).toBe("12B");
      expect(out.buildings[0].properties[0].type).toBe("SHOP");
      expect(out.buildings[0].parkings[0].owner_id).toBeNull();

      const { url, init } = lastCall(fetchMock);
      expect(url).toContain(`${BASE_URL}/api/qonshu/objects/`);
      expect(url).toContain("partner=acme");
      expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
    });

    it("maps 404 → UnknownPartnerError", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: "no" }, 404));
      await expect(
        fetchPartnerObjects({ baseUrl: BASE_URL, apiKey: API_KEY, partner: "ghost" }),
      ).rejects.toBeInstanceOf(UnknownPartnerError);
    });
  });
});
