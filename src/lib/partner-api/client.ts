// Server-only, read-only client for the external Django "Partner API". Pure fetch +
// zod validation — NO persistence, NO caching. Uses the global `fetch` (mockable in
// tests). The apiKey travels only in the `X-API-Key` header and is never placed in a
// URL, an error message, or a log line.
import {
  PartnerStatsResponseSchema,
  PartnerObjectsResponseSchema,
  PartnerListResponseSchema,
  type PartnerStatsResponse,
  type PartnerObjectsResponse,
  type PartnerListResponse,
} from "./schema";
import {
  InvalidApiKeyError,
  UnknownPartnerError,
  PartnerApiUnavailableError,
} from "./errors";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const STATS_PATH = "/api/qonshu/partner-stats/";
const OBJECTS_PATH = "/api/qonshu/objects/";
const PARTNERS_PATH = "/api/qonshu/partners/";

export type FetchPartnerStatsParams = {
  /** Overrides the `PARTNER_API_BASE_URL` env fallback. */
  baseUrl?: string;
  apiKey: string;
  partner: string;
  dateFrom: string;
  dateTo: string;
  page?: number;
  pageSize?: number;
  /** Per-request timeout; defaults to 10s. */
  timeoutMs?: number;
};

export type FetchPartnerObjectsParams = {
  baseUrl?: string;
  apiKey: string;
  partner: string;
  timeoutMs?: number;
};

// Global — not scoped to any single partner, so no `partner` field.
export type FetchPartnersParams = {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
};

// Prefer the caller-supplied base URL, fall back to env. Trailing slashes are
// stripped so we can concatenate the absolute API paths without doubling up.
function resolveBaseUrl(baseUrl?: string): string {
  const url = baseUrl ?? process.env.PARTNER_API_BASE_URL;
  if (!url || url.trim() === "") {
    throw new PartnerApiUnavailableError("Partner API base URL is not configured");
  }
  return url.trim().replace(/\/+$/, "");
}

function normalizePage(page?: number): number {
  if (page === undefined || !Number.isFinite(page)) return DEFAULT_PAGE;
  return Math.max(1, Math.floor(page));
}

function normalizePageSize(pageSize?: number): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

// Single GET path: auth header, timeout via AbortController, status→error mapping,
// JSON parse. Returns the raw body; the caller validates it against a zod schema.
async function requestJson(
  baseUrl: string,
  path: string,
  apiKey: string,
  search: URLSearchParams,
  timeoutMs: number,
): Promise<unknown> {
  const qs = search.toString();
  const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // `timeoutMs` bounds the WHOLE request — headers AND body. The timer used to be cleared in a
  // `finally` on the fetch alone, i.e. the moment response headers arrived, which left `res.json()`
  // reading the body with no timer and a dead abort signal: a server that returns 200 headers and
  // then stalls the body blocked until undici's ~300s body timeout. That broke the guarantee the
  // page-level fan-outs depend on (src/lib/tenant/company-analytics.ts, ./reports.ts and
  // src/lib/platform/overview.ts each issue one call per configured account), so a single stalled
  // body could hold a whole page open. So: one try/finally around both awaits, cleared once at the
  // end.
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (cause) {
      // Network failure or timeout (AbortError). Do NOT surface `cause` details to
      // callers as a message — it could echo the URL; attach it only as `.cause`.
      throw new PartnerApiUnavailableError("Partner API request failed", { cause });
    }

    if (res.status === 401) throw new InvalidApiKeyError();
    if (res.status === 404) throw new UnknownPartnerError();
    if (res.status >= 500) {
      throw new PartnerApiUnavailableError(`Partner API returned status ${res.status}`);
    }
    if (!res.ok) {
      // Any other non-2xx (e.g. 400/403/429) — treat as unavailable rather than leak.
      throw new PartnerApiUnavailableError(`Partner API returned status ${res.status}`);
    }

    try {
      return await res.json();
    } catch (cause) {
      // A body-read abort lands here too; report it as the timeout it is rather than
      // mislabelling a stalled stream as malformed JSON.
      throw new PartnerApiUnavailableError(
        controller.signal.aborted
          ? "Partner API request failed"
          : "Partner API returned a non-JSON response",
        { cause },
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPartnerStats(
  params: FetchPartnerStatsParams,
): Promise<PartnerStatsResponse> {
  const baseUrl = resolveBaseUrl(params.baseUrl);
  const search = new URLSearchParams({
    partner: params.partner,
    date_from: params.dateFrom,
    date_to: params.dateTo,
    page: String(normalizePage(params.page)),
    page_size: String(normalizePageSize(params.pageSize)),
  });
  const body = await requestJson(
    baseUrl,
    STATS_PATH,
    params.apiKey,
    search,
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return PartnerStatsResponseSchema.parse(body);
}

export async function fetchPartnerObjects(
  params: FetchPartnerObjectsParams,
): Promise<PartnerObjectsResponse> {
  const baseUrl = resolveBaseUrl(params.baseUrl);
  const search = new URLSearchParams({ partner: params.partner });
  const body = await requestJson(
    baseUrl,
    OBJECTS_PATH,
    params.apiKey,
    search,
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return PartnerObjectsResponseSchema.parse(body);
}

// GET /api/qonshu/partners/ — no query params; lists every partner the shared X-API-Key can see.
export async function fetchPartners(
  params: FetchPartnersParams,
): Promise<PartnerListResponse> {
  const baseUrl = resolveBaseUrl(params.baseUrl);
  const body = await requestJson(
    baseUrl,
    PARTNERS_PATH,
    params.apiKey,
    new URLSearchParams(),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return PartnerListResponseSchema.parse(body);
}
