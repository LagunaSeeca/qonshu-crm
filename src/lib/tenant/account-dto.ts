import type { Account } from "@prisma/client";

// THE single account serializer for every route that puts an Account on the wire
// (GET/POST /api/accounts, GET/PATCH /api/accounts/[id], POST /api/accounts/from-lead).
//
// Strips the partner-API secret columns from an account row before it ever reaches JSON. There is
// no per-account key entry anymore (the Partner API uses one shared X-API-Key from env — see
// src/lib/partner-api/credentials.ts), but the `externalApiKeyEnc`/`externalApiKeyLast4` columns
// still exist as a dormant override and must never leak to a client even if a row somehow has one
// set (e.g. seeded directly in the DB, or written before the shared-key switch).
//
// Lives here rather than inline in each route precisely because it was previously duplicated
// per-route and the newest route (from-lead) simply forgot it.
//
// `undefined` (not `delete`) is deliberate: JSON.stringify / NextResponse.json omit undefined
// properties, so the keys disappear from the body entirely rather than serializing as null.
export function maskAccount(account: Account) {
  return {
    ...account,
    externalApiKeyEnc: undefined,
    externalApiKeyLast4: undefined,
  };
}
