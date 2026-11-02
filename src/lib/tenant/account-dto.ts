import type { Account } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";

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
// `externalPartnerKey` GOES TOO, FOR EVERYONE BUT THE OWNER. The partner name is not a secret in
// itself — the account detail page still shows it to a team admin, read server-side straight from
// the row. What it must not be is an ANSWER: auto-link resolves a new account's name against the
// live upstream list, so echoing the resolved key back in the 201 body turned POST /api/accounts
// into a yes/no oracle for "does complex X exist upstream", over a namespace shared by every
// company on the platform — and a COMPANY_ADMIN can DELETE the probe account afterwards and ask
// again with no residue. Stripping it from the wire costs the UI nothing (no client reads the
// field off a response) and leaves the enumeration with nothing to read.
//
// A SUPER_ADMIN keeps it: the owner is who assigns these links (/partner-links), and the upstream
// list is theirs to see anyway.
//
// `undefined` (not `delete`) is deliberate: JSON.stringify / NextResponse.json omit undefined
// properties, so the keys disappear from the body entirely rather than serializing as null.
export function maskAccount(account: Account, user: SessionUser) {
  return {
    ...account,
    externalApiKeyEnc: undefined,
    externalApiKeyLast4: undefined,
    externalPartnerKey: user.role === "SUPER_ADMIN" ? account.externalPartnerKey : undefined,
  };
}
