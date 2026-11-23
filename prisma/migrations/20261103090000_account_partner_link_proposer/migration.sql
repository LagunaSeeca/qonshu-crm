-- Two-person rule for partner-link approval (security review finding F1, owner decision).
--
-- Confirming a pending link is a TEAM ADMIN's call for their own team. A team admin is also a
-- salesperson, so without a record of who PROPOSED a link, an admin could name any building and
-- approve their own access to that complex's debt, payments and unit-level owner names/phones —
-- one person on both sides of the gate. This column is the authorization input that prevents it:
-- confirmPartnerLink refuses when the actor is the proposer, unless the actor is a SUPER_ADMIN
-- (the last resort, exempt so a link they proposed is not unapprovable by anyone).
--
-- A SECOND migration rather than an edit to 20261102090000: that one is already applied to dev and
-- test, and editing an applied migration leaves Prisma's checksum mismatched and the two databases
-- silently diverged from the file.
--
-- ADDITIVE ONLY: one nullable column. No drops, no NOT NULL, no index changes.
--
-- WRAPPED IN AN EXPLICIT TRANSACTION, same discipline as 20261030120000 and 20261102090000:
-- Prisma Migrate does not wrap a migration file in one, and Postgres has transactional DDL, so
-- BEGIN/COMMIT makes this all-or-nothing.
BEGIN;

-- Bare TEXT, no foreign key, matching "PartnerLinkAudit"."actorId". Deliberate: this column must
-- never make deleting a user depend on partner-link state, and a dangling id is harmless because
-- it matches no live actor and so blocks nobody.
-- AlterTable
ALTER TABLE "Account" ADD COLUMN "partnerLinkProposedById" TEXT;

-- NO BACKFILL, and that is the correct outcome rather than an omission.
--
-- Every link that exists today is CONFIRMED (20261102090000 stamped them all), so there is no
-- pending link whose proposer could be in question. A confirmed link needs no proposer to gate on:
-- the two-person rule is checked at confirm time, which has already happened for these rows.
-- Leaving them NULL says exactly that — they predate the concept — and the column is only ever
-- read for a link that is still pending.
--
-- Nor could a proposer be recovered: PartnerLinkAudit's pre-existing rows are "auto_link", which
-- recorded the SYSTEM resolving a name, not a person proposing a complex.

COMMIT;
