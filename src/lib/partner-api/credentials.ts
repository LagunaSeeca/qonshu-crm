// Server-only. Single chokepoint for resolving the credentials needed to call the external
// Django Partner API for a given account.
//
// The upstream API authenticates every partner with ONE shared X-API-Key (PARTNER_API_KEY env
// var) — the `?partner=<name>` query param is what differentiates complexes, not the key. So an
// account goes "live" purely by having a partner NAME (externalPartnerKey); no per-account key
// entry is required or offered in the UI.
//
// The `externalApiKeyEnc` column still exists (no migration dropped it) and is honored here as a
// DORMANT OVERRIDE for a possible future per-partner-key rollout: if a row ever has one set, it
// wins over the shared env key. Nothing in the app writes to that column anymore.
//
// NEVER log the resolved apiKey, and never place it on any DTO returned to a client.
import type { Account } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto/secret";

export type PartnerCredentials = {
  baseUrl: string | undefined;
  apiKey: string;
  partner: string;
};

// Returns null when the account isn't linked yet (no partner name) or no key can be resolved
// (no per-account override AND no PARTNER_API_KEY env var) — callers must treat that as
// "not configured" and never call the API.
//
// decryptSecret can throw (tampered ciphertext / missing PARTNER_API_KEY_SECRET) when a
// per-account override is set; that throw is intentionally NOT caught here — same as the
// pre-resolver code, callers treat a throw from this function as an "unavailable"/"error" state,
// not "not configured".
export function resolvePartnerCredentials(account: Account): PartnerCredentials | null {
  const partner = account.externalPartnerKey;
  if (!partner) return null;

  const apiKey = account.externalApiKeyEnc
    ? decryptSecret(account.externalApiKeyEnc)
    : process.env.PARTNER_API_KEY;
  if (!apiKey) return null;

  return { baseUrl: process.env.PARTNER_API_BASE_URL, apiKey, partner };
}

// Credentials for endpoints that are NOT scoped to one account's partner (e.g. the partner-LIST
// picker) — no per-account override applies here, only the shared env key.
export type GlobalPartnerCredentials = {
  baseUrl: string | undefined;
  apiKey: string;
};

// Returns null when PARTNER_API_KEY is unset or empty — callers must treat that as
// "not configured" and never call the API.
export function resolveGlobalCredentials(): GlobalPartnerCredentials | null {
  const apiKey = process.env.PARTNER_API_KEY;
  if (!apiKey) return null;

  return { baseUrl: process.env.PARTNER_API_BASE_URL, apiKey };
}
