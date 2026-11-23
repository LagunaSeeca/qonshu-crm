// THE APPROVAL GATE for Account.externalPartnerKey (security review finding F1).
//
// Naming a building stakes a PENDING link (createAccount, ./accounts.ts). That link holds the
// building against other teams and grants NOTHING: resolvePartnerCredentials refuses it, so every
// partner surface reads "not configured" until it is confirmed here.
//
// WHY THIS IS A TENANT MODULE AND NOT A PLATFORM ONE. Confirming is the TEAM ADMIN's call for
// their own team's accounts — the admin who owns the relationship with that complex is the person
// who knows whether Qonshu has a contract with it. So the authorization here is ordinary account
// scoping, and it goes through the same chokepoint as every other account-scoped write:
// getAccount() returns null for anything outside the actor's scope and the caller gets a 404, the
// same shape as every other cross-team miss in the codebase. A SUPER_ADMIN passes assertRole's
// COMPANY_ADMIN check and getAccount's own super-admin branch, so they can act on any team.
//
// Its sibling src/lib/platform/account-partners.ts is the different, SUPER_ADMIN-only act:
// assigning a link to an account nobody staked one for, chosen off the live complex list.
//
// WHAT A MEMBER MAY NOT DO: confirm, including their own pending link. That separation IS the
// gate. A MEMBER and a PARTNER_VIEWER are both refused by assertRole before any lookup.
import type { Account, PrismaClient, Prisma } from "@prisma/client";
import { assertRole, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { getAccount, isPartnerKeyTaken, isPartnerKeyConflict } from "./accounts";
import { normalizeBuildingName } from "./building-claim";
import { recordPartnerLinkChange } from "./partner-link-audit";
import { accountScopeWhere } from "./scope";
import { fetchPartners } from "@/lib/partner-api/client";
import { resolveGlobalCredentials } from "@/lib/partner-api/credentials";
import {
  PartnerAlreadyClaimedError,
  PartnerListUnavailableError,
  UnknownPartnerNameError,
} from "@/lib/platform/account-partners";

// Confirm/reject were asked to act on an account that has no link awaiting a decision — it was
// never linked, or somebody already decided (another tab, a second click).
export class NoPendingPartnerLinkError extends Error {}

// THE TWO-PERSON RULE. The actor proposed this very link, so they may not approve it.
//
// A COMPANY_ADMIN is also a salesperson: without this they could name any building and approve
// their own access to that complex's debt, payments and unit-level owner names/phones, leaving one
// person on both sides of the gate and the gate worth nothing. A SUPER_ADMIN is exempt — they are
// the last resort, and without the exemption a link they proposed would be unapprovable by anyone.
//
// A CONSEQUENCE, NOT A BUG: in a team with one admin, a link that admin proposed can only be
// confirmed by the super admin. That is the shape of a two-person rule. There is deliberately no
// "sole admin may self-approve" escape hatch, because that hatch is the hole.
//
// Typed separately from ForbiddenError so the UI can say WHY — "you proposed this, ask a
// colleague" is actionable, "forbidden" is not.
export class SelfApprovalError extends Error {}

// One row of the confirmation queue: a link somebody staked by naming a building, which grants
// nothing until it is confirmed.
export type PendingPartnerLinkRow = {
  accountId: string;
  accountName: string;
  companyName: string;
  teamName: string;
  // The proposed partner name — the NORMALIZED building name the account was created with. Confirm
  // resolves it against the live list and stores the upstream's exact spelling.
  partnerName: string;
  // Who staked it, as a NAME for display, read from the durable audit row rather than from the
  // account's current manager: the manager may have changed since, and the question being answered
  // is "who asked for this". Null only for a link with no `pending` audit row — i.e. one staked
  // before this feature existed.
  //
  // DISPLAY ONLY. The two-person rule is enforced on Account.partnerLinkProposedById, never on
  // this — a log can be filtered on read, and authorization must come from current state.
  requestedBy: string | null;
  requestedAt: Date | null;
  // THIS ACTOR proposed it, so the two-person rule forbids them confirming it (see
  // SelfApprovalError). Surfaced rather than hidden: the admin needs to see the row, know it is
  // waiting, and know to ask a colleague — a row that silently vanished from their queue would
  // look like the proposal was lost.
  proposedByMe: boolean;
};

// The accounts an actor may decide links for. A team admin sees their own team; a SUPER_ADMIN
// sees every team.
//
// accountScopeWhere cannot serve the super-admin-without-a-company case: it calls requireCompany,
// and a SUPER_ADMIN has companyId null because "every company" is not a filter. Rather than invent
// a filter, that one case is stated here as the empty scope it actually is — the same sanctioned
// cross-company read as src/lib/platform/account-partners.ts, reached only after assertRole.
function approvalScope(actor: SessionUser): Prisma.AccountWhereInput {
  if (actor.role === "SUPER_ADMIN" && !actor.companyId) return {};
  return accountScopeWhere(actor);
}

// The pending queue for /partner-links.
export async function listPendingPartnerLinks(
  db: PrismaClient, actor: SessionUser,
): Promise<PendingPartnerLinkRow[]> {
  // COMPANY_ADMIN gate, which a SUPER_ADMIN also satisfies (see assertRole). A MEMBER is refused
  // here, before any query — a member must not even learn which buildings are awaiting a decision.
  assertRole(actor, ["COMPANY_ADMIN"]);

  const accounts = await db.account.findMany({
    where: {
      ...approvalScope(actor),
      externalPartnerKey: { not: null },
      partnerLinkConfirmedAt: null,
    },
    select: {
      id: true, name: true, externalPartnerKey: true, partnerLinkProposedById: true,
      company: { select: { name: true } },
      team: { select: { name: true } },
    },
    orderBy: [{ createdAt: "asc" }],
  });
  if (accounts.length === 0) return [];

  // The `pending` audit rows for exactly these accounts, newest first, so the first row seen per
  // account is the current proposal. One query, not one per account.
  const audits = await db.partnerLinkAudit.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) }, action: "pending" },
    select: { accountId: true, actorId: true, actorEmail: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }],
  });
  const latest = new Map<string, (typeof audits)[number]>();
  for (const row of audits) {
    if (row.accountId && !latest.has(row.accountId)) latest.set(row.accountId, row);
  }

  // Resolve actor names where the user still exists; the denormalized email is the fallback that
  // keeps the row readable after a deletion (the whole reason the audit stores it).
  const actorIds = [...new Set([...latest.values()].map((a) => a.actorId).filter((id): id is string => !!id))];
  const names = new Map(
    actorIds.length === 0
      ? []
      : (await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }))
          .map((u) => [u.id, u.name] as const),
  );

  return accounts.map((a) => {
    const audit = latest.get(a.id);
    const name = audit?.actorId ? names.get(audit.actorId) : undefined;
    return {
      accountId: a.id,
      accountName: a.name,
      companyName: a.company.name,
      teamName: a.team.name,
      partnerName: a.externalPartnerKey as string,
      requestedBy: name ?? audit?.actorEmail ?? null,
      requestedAt: audit?.createdAt ?? null,
      // Read off the STORED proposer, not the audit row: the stored column is what the rule is
      // actually enforced on, so the queue and the enforcement can never disagree.
      proposedByMe: actor.role !== "SUPER_ADMIN" && a.partnerLinkProposedById === actor.id,
    };
  });
}

// Load the account an approval is about, or fail exactly as any other out-of-scope account access
// does. The role check comes FIRST so a MEMBER learns nothing about whether the id exists, and the
// scope check is getAccount — one chokepoint, not a second hand-rolled filter.
async function loadForDecision(
  db: PrismaClient, actor: SessionUser, accountId: string,
): Promise<Account> {
  assertRole(actor, ["COMPANY_ADMIN"]);
  const account = await getAccount(db, actor, accountId);
  // NOT ForbiddenError: another team's account must be indistinguishable from one that does not
  // exist, which is the shape the rest of the codebase uses for every cross-team miss.
  if (!account) throw new NotFoundError("account not in scope");
  return account;
}

// Is this actor the person who proposed the link they are trying to approve?
//
// A SUPER_ADMIN is never self-approving for this purpose — the exemption is the whole reason a
// proposed link is always approvable by someone. Null proposer (a link assigned directly by the
// owner, or one predating the column) blocks nobody.
function isSelfApproval(actor: SessionUser, account: Account): boolean {
  if (actor.role === "SUPER_ADMIN") return false;
  return account.partnerLinkProposedById !== null
    && account.partnerLinkProposedById === actor.id;
}

// APPROVE a pending link: the one click that turns an account's partner data on.
//
// The name is RE-CHECKED against the live upstream list at this moment, not trusted from when it
// was staked. The pending key is whatever a salesperson typed as the account's name, normalized —
// it has never been verified against anything. So:
//   * exactly one upstream complex normalizing to it  -> confirmed, and the stored key becomes the
//     upstream's EXACT spelling (`?partner=` is matched literally upstream);
//   * zero  -> there is no such complex, so there is nothing to approve;
//   * two or more -> two upstream names collapse to one building and picking either would point
//     the account at a complex whose identity we cannot establish.
// Both refusals are UnknownPartnerNameError: the admin's next move is the same either way, and the
// distinction is not theirs to act on.
//
// THE UPSTREAM CHECK HAPPENS HERE, SERVER-SIDE, AND ANSWERS ONLY ABOUT THIS ONE NAME. A team admin
// may confirm a specific named link without ever being handed the complex list: GET /api/partners
// stays SUPER_ADMIN-only, because that list names complexes belonging to every other team and is
// an enumeration surface in its own right. Nothing in this function's result discloses more than
// yes/no for the name already on the account.
//
// Fails CLOSED when the list can't be fetched. An unverified name must never become a live link —
// that is the whole finding this gate exists for.
export async function confirmPartnerLink(
  db: PrismaClient, actor: SessionUser, accountId: string,
): Promise<Account> {
  const account = await loadForDecision(db, actor, accountId);
  if (!account.externalPartnerKey) {
    throw new NoPendingPartnerLinkError("this account has no partner link awaiting confirmation");
  }
  // THE TWO-PERSON RULE — see SelfApprovalError. Checked BEFORE the upstream call, so a proposer
  // cannot use their own confirm attempt as a probe for whether their guessed complex exists: the
  // refusal is identical whether the name is real or invented.
  if (isSelfApproval(actor, account)) {
    throw new SelfApprovalError("you proposed this link, so someone else must confirm it");
  }
  // Already approved — by another admin in another tab, or by a double click. Idempotent on
  // purpose: the state the caller asked for is the state that holds, and a second audit row would
  // claim an approval that did not happen.
  if (account.partnerLinkConfirmedAt) return account;

  const creds = resolveGlobalCredentials();
  if (!creds) throw new PartnerListUnavailableError("PARTNER_API_KEY is not configured");

  let partners: { name: string }[];
  try {
    ({ partners } = await fetchPartners({ baseUrl: creds.baseUrl, apiKey: creds.apiKey }));
  } catch (e) {
    throw new PartnerListUnavailableError("could not fetch the live partner list", { cause: e });
  }

  // Normalized comparison, not an exact one: the pending key is a normalized building name while
  // the upstream list carries display spellings.
  const pendingKey = normalizeBuildingName(account.externalPartnerKey);
  const hits = partners.filter((p) => normalizeBuildingName(p.name) === pendingKey);
  if (hits.length !== 1) {
    throw new UnknownPartnerNameError(
      `no single live partner matches "${account.externalPartnerKey}"`,
    );
  }
  const name = hits[0].name;

  // The pending link already holds the claim inside its own company, but the partner namespace is
  // GLOBAL: another company's account may hold this exact upstream spelling while ours holds the
  // normalized form. Check before writing, and let the unique index have the final word below.
  if (await isPartnerKeyTaken(db, name, accountId)) {
    throw new PartnerAlreadyClaimedError(`"${name}" is already linked to another account`);
  }

  try {
    return await db.$transaction(async (tx) => {
      const confirmed = await tx.account.update({
        where: { id: accountId },
        data: { externalPartnerKey: name, partnerLinkConfirmedAt: new Date() },
      });
      // The row that answers "when did this account become able to read this complex, and who
      // allowed it". Same transaction as the write it describes. The actor matters more than it
      // ever did: the approving admin is the accountable party for the data going out.
      await recordPartnerLinkChange(tx as PrismaClient, {
        companyId: account.companyId, accountId: account.id, accountName: account.name,
        actorId: actor.id, action: "confirm", partnerName: name,
      });
      return confirmed;
    });
  } catch (e) {
    if (isPartnerKeyConflict(e)) {
      throw new PartnerAlreadyClaimedError(`"${name}" is already linked to another account`);
    }
    throw e;
  }
}

// REFUSE a pending link: clear the key and free the building for somebody else to claim.
//
// Only a PENDING link can be rejected. Removing a link that is already live is the SUPER_ADMIN's
// setAccountPartner(…, null) — a different act with a different audit action ("clear"), and
// keeping the two verbs apart is what makes the trail readable.
//
// THE TWO-PERSON RULE DOES NOT APPLY HERE, and the asymmetry with confirm is deliberate: that rule
// exists to stop someone GRANTING themselves a complex, and refusing grants nothing. Blocking an
// admin from withdrawing their own mistyped proposal would only strand it in the queue — in a
// one-admin team, permanently.
//
// No upstream call: refusing needs no verification, and must keep working while Django is down.
export async function rejectPartnerLink(
  db: PrismaClient, actor: SessionUser, accountId: string,
): Promise<Account> {
  const account = await loadForDecision(db, actor, accountId);
  if (!account.externalPartnerKey || account.partnerLinkConfirmedAt) {
    throw new NoPendingPartnerLinkError("this account has no partner link awaiting confirmation");
  }

  return db.$transaction(async (tx) => {
    const cleared = await tx.account.update({
      where: { id: accountId },
      // The proposer goes with the key. A stale proposer on an account with no link would block
      // that person from confirming the NEXT proposal on it, which is somebody else's proposal.
      data: { externalPartnerKey: null, partnerLinkConfirmedAt: null, partnerLinkProposedById: null },
    });
    // partnerName carries the REFUSED name: after this write the column is null and nothing else
    // records what was proposed — which is exactly what the question "why is this building free
    // again" needs answered.
    await recordPartnerLinkChange(tx as PrismaClient, {
      companyId: account.companyId, accountId: account.id, accountName: account.name,
      actorId: actor.id, action: "reject", partnerName: account.externalPartnerKey,
    });
    return cleared;
  });
}
