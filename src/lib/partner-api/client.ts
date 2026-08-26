// Server-only, read-only client for the external Django "Partner API". Pure fetch +
// zod validation — NO persistence, NO caching. Uses the global `fetch` (mockable in
// tests). The apiKey travels only in the `X-API-Key` header and is never placed in a
// URL, an error message, or a log line.
import {
  PartnerStatsResponseSchema,
  PartnerObjectsResponseSchema,
  type PartnerStatsResponse,
  type PartnerObjectsResponse,
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
  } finally {
    clearTimeout(timer);
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
    throw new PartnerApiUnavailableError("Partner API returned a non-JSON response", { cause });
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
