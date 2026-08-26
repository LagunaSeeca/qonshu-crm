// Typed errors for the external Django Partner API client. Messages are static and
// NEVER interpolate the apiKey or any request secret — keep them safe to log.

export class PartnerApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

// HTTP 401 — the X-API-Key was rejected.
export class InvalidApiKeyError extends PartnerApiError {
  constructor(message = "Partner API rejected the API key", options?: { cause?: unknown }) {
    super(message, options);
  }
}

// HTTP 404 — the requested partner is not known to the upstream.
export class UnknownPartnerError extends PartnerApiError {
  constructor(message = "Partner API does not recognize this partner", options?: { cause?: unknown }) {
    super(message, options);
  }
}

// Network failure, timeout (AbortError), or 5xx (and any other non-mapped non-2xx).
export class PartnerApiUnavailableError extends PartnerApiError {
  constructor(message = "Partner API is unavailable", options?: { cause?: unknown }) {
    super(message, options);
  }
}
