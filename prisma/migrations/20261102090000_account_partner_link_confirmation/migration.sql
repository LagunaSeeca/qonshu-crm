-- Approval-gated partner links (security review finding F1).
--
-- Account.externalPartnerKey decides which external complex's debt, payments and unit-level owner
-- names/phones an account can read. Until now, writing it WAS granting it: a plain MEMBER who
-- named a building that happened to exist upstream got the link automatically and read that
-- complex's data, contract or no contract.
--
-- This adds the second half of the state machine. externalPartnerKey non-null means a link
-- EXISTS; partnerLinkConfirmedAt null means it is PENDING and authorizes nothing. Only the
-- SUPER_ADMIN's confirm (or their direct assign) stamps this column.
--
-- ADDITIVE ONLY: one nullable column plus a backfill. No drops, no NOT NULL, no index changes —
-- the claim indexes (@@unique([externalPartnerKey]), @@unique([companyId, buildingKey])) are
-- unchanged on purpose, because a PENDING link must keep holding its claim.
--
-- WRAPPED IN AN EXPLICIT TRANSACTION, same discipline as 20261030120000: Prisma Migrate does not
-- wrap a migration file in one, and a file that fails partway through otherwise leaves half its
-- work committed. Postgres has transactional DDL, so BEGIN/COMMIT makes this all-or-nothing.
BEGIN;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "partnerLinkConfirmedAt" TIMESTAMP(3);

-- BACKFILL: every link that already exists is treated as ALREADY CONFIRMED.
--
-- This is the load-bearing line of the migration. Without it the new gate reads every existing
-- link as pending and silently blanks live analytics, payments and objects for accounts that have
-- been working for months — prod has one such account and dev has seeded ones. The deploy must not
-- be the thing that takes a partner's data away; retro-approving what the owner already assigned
-- is the honest reading of history.
--
-- CURRENT_TIMESTAMP, not the account's createdAt/updatedAt: this column records when the link was
-- APPROVED, and the truthful answer for a pre-existing link is "at the moment the gate was
-- introduced". Dating it earlier would invent an approval that never happened.
UPDATE "Account"
SET "partnerLinkConfirmedAt" = CURRENT_TIMESTAMP
WHERE "externalPartnerKey" IS NOT NULL;

COMMIT;
