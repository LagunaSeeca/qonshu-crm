// SUPER_ADMIN-only assignment of an account's external partner link.
//
// Why this lives in src/lib/platform/* and not src/lib/tenant/*: the external partner namespace
// is GLOBAL. There is ONE shared PARTNER_API_KEY and `?partner=<name>` is the only thing that
// distinguishes complexes, so a partner name means the same thing to every company on the
// platform. If a COMPANY_ADMIN could name any partner, they could point their own account at
// another tenant's complex and read its debt, payments and unit-level owner names/phones. So the
// company-facing account routes no longer accept `externalPartnerKey` at all, and the only
// human-driven way to set it is here, behind assertRole(SUPER_ADMIN).
//
// Consequence of "global": these reads/writes are deliberately UNSCOPED by companyId — the same
// sanctioned cross-tenant exception as src/lib/platform/overview.ts. Every entry point asserts
// SUPER_ADMIN first, so a COMPANY_ADMIN calling straight into this module still gets a
// ForbiddenError rather than a cross-company row.
import { Prisma } from "@prisma/client";
import type { PrismaClient, Account } from "@prisma/client";
import { assertRole, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { isPartnerKeyTaken, isPartnerKeyConflict } from "@/lib/tenant/accounts";
import { recordPartnerLinkChange } from "@/lib/tenant/partner-link-audit";
import { findAllowlistEntryByName, normalizePartnerName } from "./partner-allowlist";
import { fetchPartners } from "@/lib/partner-api/client";
import { resolveGlobalCredentials } from "@/lib/partner-api/credentials";

// The named partner isn't in the live upstream list (typo, renamed, or removed). Distinct from
// "claimed" so the caller can say which of the two happened.
export class UnknownPartnerNameError extends Error {}
// The name exists upstream but another account already holds it. Refused rather than allowed:
// two accounts on one name double-count every analytics fan-out AND cross-expose two tenants.
export class PartnerAlreadyClaimedError extends Error {}
// The complex is allowlisted to a DIFFERENT company. A SUPER_ADMIN is the authority on partner
// links and may assign a complex that has no grant at all, but they must not silently contradict
// a grant they themselves made — that is how a company quietly loses the complex it was given
// while auto-link keeps trying to hand it back. Revoke or re-point the grant first.
export class PartnerAllowlistMismatchError extends Error {}
// The live list couldn't be fetched (PARTNER_API_KEY unset, upstream down, bad key, shape
// drift), so the name can't be validated. Fail CLOSED — never persist an unverified name.
export class PartnerListUnavailableError extends Error {}

export type PlatformAccountRow = {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  externalPartnerKey: string | null;
};

// Every account on the platform, with its owning company, for the assignment picker. Cross
// company by design (see file header) — a SUPER_ADMIN has companyId: null and cannot use the
// tenant-scoped listAccounts() at all.
export async function listAllAccountsForPartnerAssignment(
  db: PrismaClient, actor: SessionUser,
): Promise<PlatformAccountRow[]> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const rows = await db.account.findMany({
    select: {
      id: true, name: true, companyId: true, externalPartnerKey: true,
      company: { select: { name: true } },
    },
    orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, companyId: r.companyId,
    companyName: r.company.name, externalPartnerKey: r.externalPartnerKey,
  }));
}

// Set or clear an account's partner link.
//
// `partnerName: null` clears it — always allowed, since unlinking can't expose anything.
//
// Setting validates against the LIVE upstream list (exact name match, the same string the
// analytics fan-outs send as `?partner=`) and against every existing claim, so an unknown or
// already-taken name is rejected with a typed error instead of silently persisted. Re-saving an
// account's OWN current name is a no-op, not a clash — hence the exceptAccountId.
//
// It ALSO refuses a complex the allowlist grants to a different company. A SUPER_ADMIN stays the
// authority — an ungranted complex is still assignable — but they cannot silently contradict a
// grant, which would leave one company's auto-link permanently pointing at a complex another
// company holds. Assigning an UNgranted complex records the matching grant, so the allowlist card
// stays a complete inventory of who may read what. Every write here leaves an audit row
// (../tenant/partner-link-audit.ts), in the same transaction as the link itself.
export async function setAccountPartner(
  db: PrismaClient, actor: SessionUser, accountId: string, partnerName: string | null,
): Promise<Account> {
  assertRole(actor, ["SUPER_ADMIN"]);

  // Cross-company lookup: no companyId filter (see file header).
  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account) throw new NotFoundError("account not found");

  if (partnerName === null) {
    // The link write and its audit row are ONE unit. Separately, a failed audit insert left the
    // link already changed and returned 500 — the "link change with no audit row" state
    // ../tenant/partner-link-audit.ts exists to prevent.
    return db.$transaction(async (tx) => {
      const cleared = await tx.account.update({
        where: { id: accountId }, data: { externalPartnerKey: null },
      });
      // Only worth an audit row when something was actually unlinked. The name goes into the row:
      // after the clear the column is null, so the message is the only record of what it held.
      if (account.externalPartnerKey !== null) {
        await recordPartnerLinkChange(tx as PrismaClient, {
          companyId: account.companyId, accountId: account.id, authorId: actor.id,
          action: "clear", partnerName: account.externalPartnerKey,
        });
      }
      return cleared;
    });
  }

  const name = partnerName.trim();
  if (!name) throw new UnknownPartnerNameError("partner name is empty");

  const creds = resolveGlobalCredentials();
  if (!creds) throw new PartnerListUnavailableError("PARTNER_API_KEY is not configured");

  let partners: { name: string }[];
  try {
    ({ partners } = await fetchPartners({ baseUrl: creds.baseUrl, apiKey: creds.apiKey }));
  } catch (e) {
    // Bad key, 5xx, timeout, upstream shape drift — all collapse to "can't verify", never to
    // "assume it's fine". Chained so the cause survives for server-side logging.
    throw new PartnerListUnavailableError("could not fetch the live partner list", { cause: e });
  }

  if (!partners.some((p) => p.name === name)) {
    throw new UnknownPartnerNameError(`no live partner named "${name}"`);
  }

  // A grant to ANOTHER company blocks the assignment; no grant at all does not. Cross-company by
  // design, and safe to distinguish here in a way auto-link never may: this path is already
  // behind assertRole(SUPER_ADMIN), so the detail reaches only the person who can act on it.
  const grant = await findAllowlistEntryByName(db, name);
  if (grant && grant.companyId !== account.companyId) {
    throw new PartnerAllowlistMismatchError(
      `"${name}" is allowlisted to a different company`,
    );
  }

  if (await isPartnerKeyTaken(db, name, accountId)) {
    throw new PartnerAlreadyClaimedError(`"${name}" is already linked to another account`);
  }

  // Link, grant and audit row are ONE unit — see the clear branch above for why the audit write
  // cannot be a separate statement, and the grant write below for why it belongs here too.
  try {
    return await db.$transaction(async (tx) => {
      const updated = await tx.account.update({
        where: { id: accountId }, data: { externalPartnerKey: name },
      });

      // GRANT/ASSIGNMENT DRIFT. A SUPER_ADMIN may link an ungranted complex — they are the
      // authority — but a link with no grant behind it makes the allowlist card an INCOMPLETE
      // inventory: grantPartnerToCompany couldn't see the link, GET /api/partners hides the
      // claimed name from the picker, and nothing tied the complex back to the company actually
      // reading it. Recording the grant here makes "every live link has a matching grant" true by
      // construction, so the card is the whole picture and the two can no longer disagree.
      // `grant` is null here (a grant to another company was refused above, and one to this
      // company means there is nothing to add), so this is a create, not a re-point.
      if (!grant) {
        await tx.partnerAllowlist.create({
          data: {
            partnerName: name, normalizedName: normalizePartnerName(name),
            companyId: account.companyId, createdById: actor.id,
          },
        });
      }

      await recordPartnerLinkChange(tx as PrismaClient, {
        companyId: account.companyId, accountId: account.id, authorId: actor.id,
        action: "assign", partnerName: name,
      });
      return updated;
    });
  } catch (e) {
    // isPartnerKeyTaken above is check-then-act; @@unique([externalPartnerKey]) is what actually
    // decides. A concurrent claim surfaces as the SAME typed error the pre-check would have
    // raised, so the caller sees one consistent "already claimed" outcome either way — fail
    // closed, never a silently unverified link.
    if (isPartnerKeyConflict(e)) {
      throw new PartnerAlreadyClaimedError(`"${name}" is already linked to another account`);
    }
    // The only other unique touched in there is the allowlist's partnerName/normalizedName: a
    // grant for this complex was created between the check above and this write. The whole
    // transaction rolled back, so nothing was persisted — same fail-closed answer as a grant that
    // was already there (a retry succeeds if that grant turns out to be this company's own).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new PartnerAllowlistMismatchError(`"${name}" was just granted to another company`);
    }
    throw e;
  }
}
