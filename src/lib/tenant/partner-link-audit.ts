// Attribution for the most security-sensitive write in the app.
//
// Account.externalPartnerKey decides which external complex's debt, payments and unit-level
// owner names/phones an account can read, over a GLOBAL namespace shared by every tenant. Until
// now it changed with no record at all: nobody could answer "who linked this account to this
// complex, and when". Every path that sets or clears it — the SUPER_ADMIN assign/clear on
// /platform/accounts and the automatic link at account creation — writes one AccountActivity
// row through here.
//
// AccountActivity is reused rather than given a dedicated table: it already carries
// company + account + author + timestamp, is cascade-deleted with the account, and surfaces on
// the account timeline the tenant already reads — so the link change is visible to the company
// it affects, not just to the platform admin who made it.
import type { PrismaClient } from "@prisma/client";

export type PartnerLinkAction = "auto_link" | "assign" | "clear";

// The `outcome` marker that identifies an audit row. RESERVED: AccountActivity is otherwise
// tenant-writable (POST /api/accounts/[id]/activities takes a free-text outcome and an arbitrary
// occurredAt from any COMPANY_ADMIN/MEMBER), so without a reservation a tenant could plant rows
// that read exactly like these — forging or drowning out the trail. Every tenant-facing writer
// refuses this prefix; the two callers here are the only producers of it.
export const PARTNER_LINK_OUTCOME_PREFIX = "partner_link:";

export function isPartnerLinkOutcome(outcome: string | null | undefined): boolean {
  return typeof outcome === "string" && outcome.startsWith(PARTNER_LINK_OUTCOME_PREFIX);
}

function describe(action: PartnerLinkAction, partnerName: string | null): string {
  switch (action) {
    case "auto_link":
      return `Partner link set automatically to "${partnerName}" (allowlisted to this company)`;
    case "assign":
      return `Partner link set to "${partnerName}" by a platform admin`;
    // The name matters MOST here: after a clear the column is null, so for a link that predates
    // this audit (no prior assign row to look back at) the message is the only surviving record
    // of which complex the account was pointing at.
    case "clear":
      return partnerName
        ? `Partner link to "${partnerName}" cleared by a platform admin`
        : "Partner link cleared by a platform admin";
  }
}

// Best-effort by design at the CALLER's discretion: callers inside a transaction pass `tx` so the
// audit row lives or dies with the write it describes. Never swallow errors here — a missing
// audit row on a successful link is exactly the state this function exists to prevent.
export async function recordPartnerLinkChange(
  db: PrismaClient,
  opts: {
    companyId: string;
    accountId: string;
    // Null for a SYSTEM action with no human behind it (there is none today; auto-link records
    // the creating user), and for an actor whose id is not a User row.
    authorId: string | null;
    action: PartnerLinkAction;
    partnerName: string | null;
  },
): Promise<void> {
  await db.accountActivity.create({
    data: {
      companyId: opts.companyId,
      accountId: opts.accountId,
      authorId: opts.authorId,
      kind: "NOTE",
      body: describe(opts.action, opts.partnerName),
      outcome: `${PARTNER_LINK_OUTCOME_PREFIX}${opts.action}`,
    },
  });
}
