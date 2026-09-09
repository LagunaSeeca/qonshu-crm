// The authorization table behind partner auto-linking.
//
// WHY IT EXISTS: auto-link used to resolve a partner from the account NAME. That name is free
// text a tenant supplies, and the external partner namespace is GLOBAL (one shared
// PARTNER_API_KEY; `?partner=<name>` is the only discriminator), so any MEMBER could
// `POST /api/accounts {"name":"Someone.Elses.Complex"}` and claim another tenant's complex —
// pulling their debt, payments and unit-level owner names/phones into their own account. Worse,
// the 201 body confirmed the hit, so account creation doubled as an unauthenticated-in-practice
// enumeration oracle over every complex on the platform (no rate limit, and deleting the probe
// freed the name again).
//
// Auto-link is now a LOOKUP against this table, never a CLAIM on a name: a complex is linkable
// by exactly the one company a SUPER_ADMIN granted it to, and every other outcome — name not
// granted, granted to a different company, name doesn't exist upstream at all — collapses to the
// same `null`. That is what kills the oracle: the caller cannot tell those cases apart.
//
// NORMALIZATION (explicit choice): `partnerName` holds the EXACT upstream name — it is what gets
// sent as `?partner=` and persisted to Account.externalPartnerKey, so it must survive casing
// untouched. `normalizedName` holds the trimmed + lowercased form and is the ONLY column looked
// up by. Both are unique, so one complex can be granted to at most one company however it is
// cased. Nothing here ever does a case-insensitive scan.
//
// Note on module placement: src/lib/tenant/accounts.ts imports the read half of this file. The
// usual direction is platform -> tenant, but the grant lives on the platform side (only a
// SUPER_ADMIN may write it) while the auto-link that consumes it is a tenant-side action. There
// is no import cycle: this module imports nothing from src/lib/tenant/*.
import type { PrismaClient, PartnerAllowlist } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { assertRole, NotFoundError, type SessionUser } from "@/lib/auth/guards";

// The complex is already granted to some company. Typed so the platform card can say so instead
// of surfacing a raw P2002.
export class PartnerAllowlistConflictError extends Error {}
// The complex is already LINKED to an account in a different company. A live link is a stronger
// fact than a grant — that account is already reading the complex — so granting it elsewhere
// would leave the two permanently contradicting each other: one company holding the data, the
// other's auto-link forever trying to take it away. Flagged rather than silently allowed; clear
// the link first (setAccountPartner(..., null)).
export class PartnerAllowlistLinkConflictError extends Error {}

// Trimmed + lowercased. The single definition of "the same partner name" everywhere in the app.
export function normalizePartnerName(name: string): string {
  return name.trim().toLowerCase();
}

// UNGUARDED, by design: the caller is the auto-link path, which runs as the tenant creating the
// account. It is safe because the answer is only ever "the exact upstream name YOUR company was
// granted" or null — never another company's grant, and never a hint that one exists.
export async function resolveAllowlistedPartner(
  db: PrismaClient, companyId: string, accountName: string,
): Promise<string | null> {
  const normalized = normalizePartnerName(accountName);
  if (!normalized) return null;
  const row = await db.partnerAllowlist.findUnique({ where: { normalizedName: normalized } });
  if (!row) return null;
  // A grant to a DIFFERENT company is indistinguishable from no grant at all — same null, same
  // absent link, nothing in the response. Do not "helpfully" differentiate these.
  if (row.companyId !== companyId) return null;
  return row.partnerName;
}

// Who, if anyone, a partner name is granted to. Used by setAccountPartner to refuse an assignment
// that contradicts an existing grant. Unscoped by companyId on purpose — the caller is
// SUPER_ADMIN-gated and needs the cross-company answer.
export function findAllowlistEntryByName(
  db: PrismaClient, partnerName: string,
): Promise<PartnerAllowlist | null> {
  const normalized = normalizePartnerName(partnerName);
  if (!normalized) return Promise.resolve(null);
  return db.partnerAllowlist.findUnique({ where: { normalizedName: normalized } });
}

export type PartnerAllowlistRow = {
  id: string;
  partnerName: string;
  companyId: string;
  companyName: string;
  createdAt: Date;
};

// Every grant on the platform, with its owning company, for the management card. Cross-company
// by design — a SUPER_ADMIN has companyId: null and cannot use any tenant-scoped query.
export async function listPartnerAllowlist(
  db: PrismaClient, actor: SessionUser,
): Promise<PartnerAllowlistRow[]> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const rows = await db.partnerAllowlist.findMany({
    select: {
      id: true, partnerName: true, companyId: true, createdAt: true,
      company: { select: { name: true } },
    },
    orderBy: [{ company: { name: "asc" } }, { partnerName: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, partnerName: r.partnerName, companyId: r.companyId,
    companyName: r.company.name, createdAt: r.createdAt,
  }));
}

// Grant a complex to a company. SUPER_ADMIN-only — they are the authority on who owns which
// complex, so this deliberately does NOT re-validate the name against the live upstream list: a
// grant is an authorization statement, and setAccountPartner still checks the live list at the
// moment a link is actually written.
export async function grantPartnerToCompany(
  db: PrismaClient, actor: SessionUser, partnerName: string, companyId: string,
): Promise<PartnerAllowlistRow> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const name = partnerName.trim();
  if (!name) throw new NotFoundError("partner name is empty");

  const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true } });
  if (!company) throw new NotFoundError("company not found");

  // Don't contradict a LIVE link. setAccountPartner records a grant for every link it writes, so
  // this can only fire for a link that predates that (or one written straight to the column), but
  // those are exactly the ones nobody can see from the allowlist card. Case-insensitive because
  // "the same complex" is defined by normalizePartnerName everywhere else. Cross-company read,
  // like every other query in this module — the caller is already SUPER_ADMIN-gated.
  const linked = await db.account.findFirst({
    where: { externalPartnerKey: { equals: name, mode: "insensitive" } },
    select: { companyId: true },
  });
  if (linked && linked.companyId !== companyId) {
    throw new PartnerAllowlistLinkConflictError(
      `"${name}" is already linked to an account in another company`,
    );
  }

  try {
    const row = await db.partnerAllowlist.create({
      data: {
        partnerName: name,
        normalizedName: normalizePartnerName(name),
        companyId,
        createdById: actor.id,
      },
    });
    return {
      id: row.id, partnerName: row.partnerName, companyId: row.companyId,
      companyName: company.name, createdAt: row.createdAt,
    };
  } catch (e) {
    // Unique on partnerName/normalizedName: the complex is already granted (to this company or
    // another). Revoke the existing grant first rather than silently re-pointing it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new PartnerAllowlistConflictError(`"${name}" is already granted to a company`);
    }
    throw e;
  }
}

// Revoke a grant. This removes FUTURE auto-link authorization only; an account that already
// holds the link keeps it, because clearing a live link is a separate, deliberate action
// (setAccountPartner(..., null)) with its own audit row.
export async function revokePartnerAllowlistEntry(
  db: PrismaClient, actor: SessionUser, id: string,
): Promise<void> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const row = await db.partnerAllowlist.findUnique({ where: { id }, select: { id: true } });
  if (!row) throw new NotFoundError("allowlist entry not found");
  await db.partnerAllowlist.delete({ where: { id } });
}
