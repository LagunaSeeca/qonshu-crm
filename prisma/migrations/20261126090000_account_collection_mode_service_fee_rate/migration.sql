-- Account money model: who collects the residents' money, and the agreed monthly fee rate.
--
-- Additive only, no data loss, no backfill.
--
-- EXPLICIT BEGIN/COMMIT, matching 20261124090100 and the house rule it states. An earlier version
-- of this file claimed Prisma wraps a migration file in an implicit transaction and omitted them;
-- that is wrong, and this repo has the scar to prove it — 20261030120000_org_teams_building_claim
-- _partner_audit was left HALF-APPLIED. Without the wrapper, if the ALTER TABLE below fails (a
-- lock timeout on a busy "Account" is the realistic case) the CREATE TYPE has already committed,
-- and the retry dies on 'type "CollectionMode" already exists' needing manual repair.
--
-- Both ADD COLUMNs are metadata-only on Postgres 11+ (a constant default is stored in the
-- catalog and the nullable column needs no default), so the "Account" table is not rewritten.

BEGIN;

-- CreateEnum
CREATE TYPE "CollectionMode" AS ENUM ('QONSHU', 'SELF');

-- AlterTable
-- collectionMode defaults to QONSHU, the behaviour every existing account already has.
-- monthlyServiceFee is NULL = no agreed rate (skipped by monthly fee generation); NUMERIC(65,30)
-- is what Prisma maps Decimal to, matching SettlementEntry.amount and ServiceFee.amount.
ALTER TABLE "Account" ADD COLUMN     "collectionMode" "CollectionMode" NOT NULL DEFAULT 'QONSHU',
ADD COLUMN     "monthlyServiceFee" DECIMAL(65,30);

COMMIT;
