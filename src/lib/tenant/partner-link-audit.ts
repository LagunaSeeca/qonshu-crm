// Attribution for the most security-sensitive write in the app.
//
// Account.externalPartnerKey decides which external complex's debt, payments and unit-level
// owner names/phones an account can read, over a GLOBAL namespace shared by every account on the
// platform. Until now it changed with no record at all: nobody could answer "who linked this
// account to this complex, and when". Every path that proposes, approves, refuses, sets or clears
// it — the pending link recorded at account creation or rename, the confirm/reject on
// /partner-links (a team admin for their own team, or the owner anywhere), and the SUPER_ADMIN
// assign/clear on the same page — writes one row through here.
//
// IT WRITES TO PartnerLinkAudit, NOT AccountActivity. AccountActivity is cascade-deleted with its
// account, so deleting the account destroyed the record of who had pointed it at which complex —
// exactly the question an audit exists to answer, and exactly the record someone covering their
// tracks would want gone. PartnerLinkAudit is attached to nothing that cascades: a nullable
// accountId with SET NULL, and bare companyId/actorId columns with no relations at all.
//
// Because the account FK can go null and the company/actor are unresolvable joins, everything
// needed to READ the row later is DENORMALIZED here at write time: accountName, partnerName and
// actorEmail are snapshots of what was true when the link changed. They are intentionally NOT kept
// in sync afterwards — the audit records what the admin saw, not what things are called today.
import type { PrismaClient } from "@prisma/client";

// Every transition of the link state machine (Account.externalPartnerKey +
// Account.partnerLinkConfirmedAt, with Account.partnerLinkProposedById recording who asked):
//
//   "pending" — somebody named (or renamed) a building, so a link was recorded that grants
//               NOTHING yet. Actor is that person, and the same id is stored on
//               Account.partnerLinkProposedById so they cannot confirm it themselves. This is a
//               PROPOSAL, not an entitlement — an admin proposing is still only proposing.
//   "confirm" — an admin approved it on /partner-links, after the name was re-checked against the
//               live upstream list. Actor is that admin — the team's own admin, or the owner — and
//               they are the ACCOUNTABLE PARTY for the data going out. THIS is the row that says
//               when the account became able to read the complex. Never the proposer: the
//               two-person rule forbids confirming your own proposal (SUPER_ADMIN exempt).
//   "reject"  — an admin refused it; the key is cleared and the building freed.
//   "assign"  — the SUPER_ADMIN set the link directly (also an approval, so it confirms too).
//   "clear"   — a confirmed link was removed.
//
// "auto_link" is NOT in this union any more: nothing may write it. It is the historical value
// carried by rows from before the approval gate existed, when naming a building granted the data
// outright — see the migration note in prisma/schema.prisma. Rows keep it; readers must tolerate
// it; writers cannot produce it.
export type PartnerLinkAction = "pending" | "confirm" | "reject" | "assign" | "clear";

// The `outcome` marker that used to identify an audit row while the trail lived in
// AccountActivity. STILL RESERVED from tenant writers: historical rows carry it, and
// AccountActivity is otherwise tenant-writable (POST /api/accounts/[id]/activities takes a
// free-text outcome and an arbitrary occurredAt from any COMPANY_ADMIN/MEMBER), so dropping the
// reservation would let a tenant plant rows indistinguishable from the pre-migration trail.
// Nothing PRODUCES this prefix any more — the table above is the only writer.
export const PARTNER_LINK_OUTCOME_PREFIX = "partner_link:";

export function isPartnerLinkOutcome(outcome: string | null | undefined): boolean {
  return typeof outcome === "string" && outcome.startsWith(PARTNER_LINK_OUTCOME_PREFIX);
}

// Never swallow errors here — a missing audit row on a successful link is exactly the state this
// function exists to prevent. Callers inside a transaction pass `tx` so the audit row lives or
// dies with the write it describes.
export async function recordPartnerLinkChange(
  db: PrismaClient,
  opts: {
    companyId: string;
    accountId: string;
    // Snapshot, required: once accountId goes null this is the ONLY readable identification of
    // which account the link belonged to.
    accountName: string;
    // Null for a SYSTEM action with no human behind it, and for an actor whose id is not a User
    // row (a super admin acting through a platform path still is one).
    actorId: string | null;
    // Pass it when the caller already has it; otherwise it is resolved from actorId here, once, so
    // the stored row names a person even after that user is deleted. Explicitly `null` means
    // "there is no email" and skips the lookup.
    actorEmail?: string | null;
    action: PartnerLinkAction;
    // For a "clear" this is the name the link HELD, which is otherwise unrecoverable: after the
    // write the column is null and no later read can tell you what it pointed at.
    partnerName: string | null;
  },
): Promise<void> {
  const actorEmail =
    opts.actorEmail !== undefined
      ? opts.actorEmail
      : opts.actorId
        ? (await db.user.findUnique({ where: { id: opts.actorId }, select: { email: true } }))?.email ?? null
        : null;

  await db.partnerLinkAudit.create({
    data: {
      companyId: opts.companyId,
      accountId: opts.accountId,
      accountName: opts.accountName,
      partnerName: opts.partnerName,
      action: opts.action,
      actorId: opts.actorId,
      actorEmail,
    },
  });
}
