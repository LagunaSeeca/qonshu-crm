// SUPER_ADMIN-only DIRECT assignment of an account's external partner link.
//
// This is not the only way a link is created, and it is not the common one. A salesperson naming a
// building stakes a PENDING link, which a TEAM ADMIN then confirms for their own team — that path
// is team-scoped and lives in src/lib/tenant/partner-link-approval.ts. This module is the other
// act: the owner picking a complex off the live list and attaching it to an account nobody staked
// one for, plus clearing a link that is already live.
//
// EVERY ENTRY POINT HERE IS assertRole(SUPER_ADMIN) AND EVERY QUERY IS UNSCOPED. Do not add a
// team-scoped function to this file: the queries below are written on the assumption that the
// caller is above every company, and a function copied into that style with a lesser caller would
// read straight across teams. Team-scoped partner-link work belongs in the tenant module named
// above.
//
// Why this lives in src/lib/platform/* and not src/lib/tenant/*: the external partner namespace
// is GLOBAL. There is ONE shared PARTNER_API_KEY and `?partner=<name>` is the only thing that
// distinguishes complexes, so a partner name means the same thing to every account on the
// platform. If a COMPANY_ADMIN could name any partner, they could point their own account at
// another team's complex and read its debt, payments and unit-level owner names/phones. So the
// tenant-facing account routes do not accept `externalPartnerKey` at all, and the only way to
// name a complex FREELY is here, behind assertRole(SUPER_ADMIN). The team-admin confirm path
// cannot name a complex at all: it can only approve the name already on the account, which was
// derived from the account's own building name and is re-verified upstream at that moment.
//
// Consequence of "global": these reads/writes are deliberately UNSCOPED by companyId — a
// sanctioned cross-tenant exception. Every entry point asserts SUPER_ADMIN first, so a
// COMPANY_ADMIN calling straight into this module still gets a ForbiddenError rather than a row
// they should not see.
import type { PrismaClient, Account } from "@prisma/client";
import { assertRole, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { isPartnerKeyTaken, isPartnerKeyConflict } from "@/lib/tenant/accounts";
import { recordPartnerLinkChange } from "@/lib/tenant/partner-link-audit";
import { normalizeBuildingName } from "@/lib/tenant/building-claim";
import { fetchPartners } from "@/lib/partner-api/client";
import { resolveGlobalCredentials } from "@/lib/partner-api/credentials";

// The named partner isn't in the live upstream list (typo, renamed, or removed). Distinct from
// "claimed" so the caller can say which of the two happened.
export class UnknownPartnerNameError extends Error {}
// The name exists upstream but another account already holds the LINK. Refused rather than
// allowed: two accounts on one name double-count every analytics fan-out AND show one team's
// complex to another.
export class PartnerAlreadyClaimedError extends Error {}
// The name normalizes to a BUILDING some other record already claims — a lead someone is working,
// or another account. A partner name and a building name are the same identity
// (normalizeBuildingName), so assigning it here would hand a super admin a side door around the
// one-building-one-team rule the claim guard enforces everywhere else, and would leave two records
// pointing at one complex with no way to say which is right. `holder` names the record so the
// admin can go and fix it; resolving the clash means REASSIGNING, never duplicating.
export class PartnerNameHeldError extends Error {
  readonly holderKind: "lead" | "account";
  readonly holderId: string;
  constructor(message: string, holder: { kind: "lead" | "account"; id: string }) {
    super(message);
    this.name = "PartnerNameHeldError";
    this.holderKind = holder.kind;
    this.holderId = holder.id;
  }
}
// The live list couldn't be fetched (PARTNER_API_KEY unset, upstream down, bad key, shape
// drift), so the name can't be validated. Fail CLOSED — never persist an unverified name.
export class PartnerListUnavailableError extends Error {}
// A pending link has no live link to show, so the picker distinguishes the three states rather
// than printing a key that authorizes nothing.
export type PlatformAccountRow = {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  // The CONFIRMED key, or null. A pending key is deliberately NOT reported here: the Assign/Clear
  // control acts on live links, and showing a pending proposal in the "currently linked to" slot
  // is how an owner comes to believe data is flowing when it is not.
  externalPartnerKey: string | null;
  // There is a link recorded, awaiting confirmation. Governed by the team-scoped queue in
  // ../tenant/partner-link-approval.ts, not by Assign/Clear here.
  partnerLinkPending: boolean;
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
      id: true, name: true, companyId: true, externalPartnerKey: true, partnerLinkConfirmedAt: true,
      company: { select: { name: true } },
    },
    orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, companyId: r.companyId, companyName: r.company.name,
    externalPartnerKey: r.partnerLinkConfirmedAt ? r.externalPartnerKey : null,
    partnerLinkPending: r.externalPartnerKey !== null && r.partnerLinkConfirmedAt === null,
  }));
}

// Is this partner name claimed, as a BUILDING, by anything but this account and the lead it came
// from? Returns the holder so the error can name it.
//
// The two exceptions are the only records entitled to the name: the account being assigned, and
// the won lead it was converted from (a lead and its account legitimately share one buildingKey —
// separate tables, separate unique indexes).
//
// The account side compares BOTH columns: `buildingKey`, and `externalPartnerKey` normalized.
// A live link is a claim on the building even when the key says otherwise (a rename, or a link
// assigned before buildingKey existed), and the normalization is done in JS because Postgres
// cannot express it identically — its `lower()` does not produce the combining dot
// normalizeBuildingName strips.
async function findNameHolder(
  db: PrismaClient, key: string, account: Pick<Account, "id" | "sourceLeadId">,
): Promise<{ kind: "lead" | "account"; id: string; label: string } | null> {
  const exceptLead = account.sourceLeadId ? { id: { not: account.sourceLeadId } } : {};
  const lead = await db.lead.findFirst({
    where: { buildingKey: key, ...exceptLead },
    select: { id: true, title: true, companyName: true, owner: { select: { name: true } }, team: { select: { name: true } } },
  });
  if (lead) {
    return {
      kind: "lead", id: lead.id,
      label: `lead "${lead.companyName ?? lead.title}" (${lead.owner.name}, ${lead.team.name})`,
    };
  }

  const candidates = await db.account.findMany({
    where: {
      id: { not: account.id },
      OR: [{ buildingKey: key }, { externalPartnerKey: { not: null } }],
    },
    select: {
      id: true, name: true, buildingKey: true, externalPartnerKey: true,
      accountManager: { select: { name: true } }, team: { select: { name: true } },
    },
  });
  const hit = candidates.find(
    (a) => a.buildingKey === key || normalizeBuildingName(a.externalPartnerKey ?? "") === key,
  );
  return hit
    ? {
        kind: "account", id: hit.id,
        label: `account "${hit.name}" (${hit.accountManager.name}, ${hit.team.name})`,
      }
    : null;
}

// Set or clear an account's partner link.
//
// `partnerName: null` clears it — always allowed, since unlinking can't expose anything.
//
// Setting validates three things, in this order:
//   1. the name exists in the LIVE upstream list (exact match — the same string the analytics
//      fan-outs send as `?partner=`), so an unverified name is never persisted;
//   2. no OTHER lead or account already claims that building (findNameHolder above);
//   3. no other account already holds the link itself.
// Re-saving an account's OWN current name is a no-op, not a clash — hence the exceptions.
//
// Every write leaves an audit row (../tenant/partner-link-audit.ts) in the same transaction as the
// link itself.
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
        // The confirmation stamp goes with the key. Leaving it set would make the NEXT pending
        // link on this account read as already approved — a link staked by a salesperson that
        // authorizes the complex's data from the moment it is written.
        where: { id: accountId }, data: { externalPartnerKey: null, partnerLinkConfirmedAt: null },
      });
      // Only worth an audit row when something was actually unlinked. The name goes into the row:
      // after the clear the column is null, so the row is the only record of what it held.
      if (account.externalPartnerKey !== null) {
        await recordPartnerLinkChange(tx as PrismaClient, {
          companyId: account.companyId, accountId: account.id, accountName: account.name,
          actorId: actor.id, action: "clear", partnerName: account.externalPartnerKey,
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

  // Safe to name the holder here in a way the tenant-facing claim guard never may: this path is
  // already behind assertRole(SUPER_ADMIN), so the detail reaches only the person who can act on
  // it.
  const held = await findNameHolder(db, normalizeBuildingName(name), account);
  if (held) {
    throw new PartnerNameHeldError(
      `"${name}" is already held by ${held.label} — reassign that record instead of duplicating the link`,
      held,
    );
  }

  if (await isPartnerKeyTaken(db, name, accountId)) {
    throw new PartnerAlreadyClaimedError(`"${name}" is already linked to another account`);
  }

  // Link and audit row are ONE unit — see the clear branch above for why the audit write cannot be
  // a separate statement.
  try {
    return await db.$transaction(async (tx) => {
      const updated = await tx.account.update({
        // CONFIRMED IMMEDIATELY. This path IS the owner saying yes: it is behind
        // assertRole(SUPER_ADMIN), the name was just verified against the live list, and the
        // actor is the same person who would otherwise confirm it a second later. Leaving it
        // pending would make the owner approve their own explicit assignment, and would make this
        // path write a link that silently reads as "not configured".
        where: { id: accountId }, data: { externalPartnerKey: name, partnerLinkConfirmedAt: new Date() },
      });
      await recordPartnerLinkChange(tx as PrismaClient, {
        companyId: account.companyId, accountId: account.id, accountName: account.name,
        actorId: actor.id, action: "assign", partnerName: name,
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
    throw e;
  }
}
