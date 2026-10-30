import type { PrismaClient } from "@prisma/client";
import { isAdmin, type SessionUser } from "@/lib/auth/guards";

// ONE BUILDING, ONE TEAM. A building (a residential complex) is worked as a Lead and then kept
// as an Account, and only one team in the company may hold it at a time — a LOST lead keeps its
// claim until someone reassigns it. This module is the single place that decides whether a
// claim is free and what the caller is allowed to be told when it is not.

// The normalized form of a building name: this IS the claim identity, and the value stored in
// Lead.buildingKey / Account.buildingKey behind `@@unique([companyId, buildingKey])`.
//
// IT MUST STAY BYTE-IDENTICAL to `buildingKey()` in src/test/fixtures.ts, which mirrors the
// migration backfill that produced every existing key
// (`lower(regexp_replace(btrim(normalize(name, NFKC)), '\s+', ' ', 'g'))`). Same steps, same
// order: NFKC, trim, collapse whitespace runs, lowercase, strip U+0307.
//
// WHY THE U+0307 STRIP: `"İ".toLowerCase()` in JS yields "i" + U+0307 COMBINING DOT ABOVE,
// whereas Postgres `lower()` yields a bare "i". Without the strip, every Azerbaijani name
// ("İSMAYIL bey", "İŞIQ") would have the app computing a key the database's own backfill could
// never produce — two spellings of one building, each claimable separately.
//
// WHY THE STRIP COMES LAST (after trim/collapse, not before): that is the order fixtures.ts and
// the backfill use, and the keys already in the database were produced that way. The orders
// differ only for the pathological input of a bare combining dot surrounded by spaces, and for
// that input the stored key is the one this order produces. Matching the data wins.
//
// This supersedes normalizePartnerName() in src/lib/platform/partner-allowlist.ts, which only
// trimmed and lowercased — so it matched neither the backfill (no whitespace collapse) nor the
// Azerbaijani spellings (no dot strip).
export function normalizeBuildingName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/̇/g, "");
}

export type ClaimRecordKind = "lead" | "account";

// 409, not 500 and not a bare P2002: a taken building is an ordinary, expected outcome of two
// salespeople walking into the same complex, and the person who hits it needs to know who holds
// it. `message` is built per-caller (see claimMessage) and is the ONLY field errorResponse puts
// on the wire — holderName/recordId stay server-side for logging and for callers that want to
// render their own copy.
export class BuildingClaimedError extends Error {
  readonly holderName: string;
  readonly holderTeamName: string;
  readonly isSelf: boolean;
  readonly recordKind: ClaimRecordKind;
  readonly recordId: string;

  constructor(args: {
    message: string;
    holderName: string;
    holderTeamName: string;
    isSelf: boolean;
    recordKind: ClaimRecordKind;
    recordId: string;
  }) {
    super(args.message);
    this.name = "BuildingClaimedError";
    this.holderName = args.holderName;
    this.holderTeamName = args.holderTeamName;
    this.isSelf = args.isSelf;
    this.recordKind = args.recordKind;
    this.recordId = args.recordId;
  }
}

// Who holds the claim, flattened from whichever of the three sources matched.
type Holder = {
  recordKind: ClaimRecordKind;
  recordId: string;
  holderName: string;
  holderTeamName: string;
  holderUserId: string;
  holderTeamId: string;
};

// A transaction client (or anything shaped like one). Deliberately NOT PrismaClient: see the
// runtime check in assertBuildingUnclaimed.
type ClaimTx = Pick<PrismaClient, "lead" | "account" | "$queryRaw">;

export type ClaimArgs = {
  companyId: string;
  // The already-normalized key, from normalizeBuildingName.
  key: string;
  // The caller. Required because the MESSAGE depends on who is asking: a MEMBER may be told
  // only the holder's name and team, never anything from inside the record.
  user: SessionUser;
  // Optional raw name, purely for the message, so it quotes what the person typed rather than
  // the lowercased key. Never read from the holder's record.
  name?: string;
  // "Taken by SOMEONE ELSE?" — an update re-saving a record's own current building must not
  // report itself as a clash.
  exceptLeadId?: string;
  exceptAccountId?: string;
};

// Throws BuildingClaimedError if this building is already claimed in this company, otherwise
// returns and lets the caller write.
//
// MUST BE CALLED INSIDE THE CALLER'S $transaction, immediately before the insert/update:
// pg_advisory_xact_lock is held until that transaction ends, and that is the whole mechanism.
// A lead and an account live in DIFFERENT tables with SEPARATE unique indexes, so two
// concurrent writers — one creating a lead for "Sabah City", one converting a won lead for
// "Sabah City" into an account — both read "free" and both commit. No single-table unique
// index can catch that. The advisory lock serialises them on (companyId, key) so the second
// one reads the first one's committed row.
export async function assertBuildingUnclaimed(tx: ClaimTx, args: ClaimArgs): Promise<void> {
  const { companyId, key, user, exceptLeadId, exceptAccountId } = args;

  // Passing a full PrismaClient would put the lock in its own implicit transaction, which
  // commits at the end of that one statement and releases the lock before the caller ever
  // writes — i.e. the guard would look like it worked while serialising nothing. Fail loudly.
  //
  // DISCRIMINATED ON $connect, NOT $transaction. This check was written as `"$transaction" in tx`
  // on the reasonable-sounding theory that only a full client has it. On Prisma 7 (7.8.0 here)
  // that is false: the interactive-transaction client supports NESTED transactions and so carries
  // `$transaction` too — making the condition true for both, and this guard a function that threw
  // for every caller without exception. `$connect`/`$extends` are the properties the itx client
  // genuinely lacks (ITXClientDenyList), so `$connect` is the discriminator that holds.
  if ("$connect" in tx) {
    throw new Error("assertBuildingUnclaimed must be called with a transaction client");
  }

  // Lock FIRST, then read. hashtext() maps the key to the int4 the advisory-lock API wants;
  // a hash collision between two different buildings costs one needless wait, never a wrong
  // answer, because the reads below still compare the real strings.
  //
  // THE SUBSELECT IS LOAD-BEARING. pg_advisory_xact_lock() returns `void`, and the pg driver
  // adapter has no mapping for that native type: selecting it directly made every call fail with
  // P2010 / UnsupportedNativeDataType { type: "void" }, so the lock was never taken. Keeping the
  // void column inside the subquery means the driver only ever decodes the int4 `locked` column,
  // while the function still executes (and the lock is still held to the end of this
  // transaction) because the subquery is evaluated.
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:${key}`}))) AS lock_taken`;

  const holder =
    (await findLeadHolder(tx, companyId, key, exceptLeadId)) ??
    (await findAccountHolder(tx, companyId, key, exceptAccountId)) ??
    (await findPartnerKeyHolder(tx, companyId, key, exceptAccountId));
  if (!holder) return;

  const isSelf = holder.holderUserId === user.id;
  throw new BuildingClaimedError({
    message: claimMessage(holder, user, args.name?.trim() || key, isSelf),
    holderName: holder.holderName,
    holderTeamName: holder.holderTeamName,
    isSelf,
    recordKind: holder.recordKind,
    recordId: holder.recordId,
  });
}

// What the caller is allowed to be told.
//
// A MEMBER who is not the holder gets the holder's NAME and TEAM and nothing else: no link, no
// id, nothing from inside a record they cannot open. That is the point of the message — it
// tells them whom to talk to without leaking another member's book. The holder themselves, a
// team admin whose own team holds it, and a super admin all get a link, because for them the
// record is already in scope and the next step is to open it.
function claimMessage(holder: Holder, user: SessionUser, display: string, isSelf: boolean): string {
  const link = holder.recordKind === "lead" ? `/crm/${holder.recordId}` : `/accounts/${holder.recordId}`;
  if (isSelf) return `You already have this building — ${link}`;
  const base = `"${display}" is already registered to ${holder.holderName} (${holder.holderTeamName}). Ask your team admin to reassign it.`;
  const inScope =
    user.role === "SUPER_ADMIN" || (isAdmin(user) && !!user.teamId && user.teamId === holder.holderTeamId);
  return inScope ? `${base} ${link}` : base;
}

async function findLeadHolder(
  tx: ClaimTx, companyId: string, key: string, exceptLeadId?: string,
): Promise<Holder | null> {
  const lead = await tx.lead.findFirst({
    where: { companyId, buildingKey: key, ...(exceptLeadId ? { id: { not: exceptLeadId } } : {}) },
    select: { id: true, teamId: true, owner: { select: { id: true, name: true } }, team: { select: { name: true } } },
  });
  if (!lead) return null;
  return {
    recordKind: "lead",
    recordId: lead.id,
    holderName: lead.owner.name,
    holderTeamName: lead.team.name,
    holderUserId: lead.owner.id,
    holderTeamId: lead.teamId,
  };
}

async function findAccountHolder(
  tx: ClaimTx, companyId: string, key: string, exceptAccountId?: string,
): Promise<Holder | null> {
  const account = await tx.account.findFirst({
    where: { companyId, buildingKey: key, ...(exceptAccountId ? { id: { not: exceptAccountId } } : {}) },
    select: {
      id: true, teamId: true,
      accountManager: { select: { id: true, name: true } },
      team: { select: { name: true } },
    },
  });
  return account && toAccountHolder(account);
}

// The third source: an account LINKED to the external partner API under this building, whose
// externalPartnerKey normalizes to the same key. That link is how a complex is addressed
// upstream, so holding it is holding the building even if buildingKey says otherwise (a rename,
// or a link assigned before the key existed).
//
// Compared in JS rather than in SQL: the comparison is normalizeBuildingName, which Postgres
// cannot express identically (its lower() does not produce the combining dot the strip removes),
// and the set is small — only linked accounts, scoped to the company.
//
// SCOPED BY companyId even though the partner namespace itself is global. A cross-company holder
// is not a claim conflict here (claims are per company, per the unique indexes) and naming its
// manager and team in the message would leak another tenant's staff. Global double-links stay
// the job of the `@@unique([externalPartnerKey])` index and the platform re-assign path.
async function findPartnerKeyHolder(
  tx: ClaimTx, companyId: string, key: string, exceptAccountId?: string,
): Promise<Holder | null> {
  const linked = await tx.account.findMany({
    where: {
      companyId,
      externalPartnerKey: { not: null },
      ...(exceptAccountId ? { id: { not: exceptAccountId } } : {}),
    },
    select: {
      id: true, teamId: true, externalPartnerKey: true,
      accountManager: { select: { id: true, name: true } },
      team: { select: { name: true } },
    },
  });
  const hit = linked.find((a) => normalizeBuildingName(a.externalPartnerKey ?? "") === key);
  return hit ? toAccountHolder(hit) : null;
}

function toAccountHolder(account: {
  id: string;
  teamId: string;
  accountManager: { id: string; name: string };
  team: { name: string };
}): Holder {
  return {
    recordKind: "account",
    recordId: account.id,
    holderName: account.accountManager.name,
    holderTeamName: account.team.name,
    holderUserId: account.accountManager.id,
    holderTeamId: account.teamId,
  };
}
