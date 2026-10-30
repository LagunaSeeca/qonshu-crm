// Attribution for the most security-sensitive write in the app.
//
// Account.externalPartnerKey decides which external complex's debt, payments and unit-level
// owner names/phones an account can read, over a GLOBAL namespace shared by every account on the
// platform. Until now it changed with no record at all: nobody could answer "who linked this
// account to this complex, and when". Every path that sets or clears it — the SUPER_ADMIN
// assign/clear on /platform/accounts, the automatic link at account creation, and the
// opportunistic re-link on the Analytics tab — writes one row through here.
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

export type PartnerLinkAction = "auto_link" | "assign" | "clear";

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
