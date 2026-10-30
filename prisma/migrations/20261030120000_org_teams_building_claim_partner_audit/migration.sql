-- Wave A: multi-tenant (Company = customer org) -> ONE org + Teams.
--
-- HAND-EDITED. `prisma migrate diff` emits the new Lead/Account columns as NOT NULL with no
-- backfill, which fails instantly on any non-empty table. The generated statements are therefore
-- reordered into the standard expand/backfill/contract shape:
--   1. create Team + PartnerLinkAudit (the backfill needs Team rows to exist)
--   2. add every new column NULLABLE
--   3. backfill
--   4. SET NOT NULL
--   5. drop what's going away
--   6. indexes, unique constraints and remaining foreign keys
--
-- Requires PostgreSQL >= 13 for gen_random_uuid() (core since 13) and normalize(..., NFKC)
-- (added in 13). Verified: Docker image is postgres:16, dev and test both report 16.14.
--
-- WRAPPED IN AN EXPLICIT TRANSACTION. Prisma Migrate does NOT wrap a migration file in one:
-- an earlier revision of this file failed partway through on dev and left the new tables,
-- the new columns and a half-done backfill committed, which then had to be unwound by hand.
-- Postgres has transactional DDL, so BEGIN/COMMIT makes the whole migration all-or-nothing.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New tables
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Team_companyId_idx" ON "Team"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_companyId_name_key" ON "Team"("companyId", "name");

-- CreateTable
-- Durable partner-link audit. Deliberately has NO cascade into it from anywhere: accountId is
-- nullable + SET NULL, and companyId/actorId are bare columns with no FK, so a row survives the
-- deletion of its account, its lead, its company and the user who acted. accountName /
-- partnerName / actorEmail are denormalized snapshots so the row still reads afterwards.
CREATE TABLE "PartnerLinkAudit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT,
    "accountName" TEXT NOT NULL,
    "partnerName" TEXT,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerLinkAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerLinkAudit_companyId_createdAt_idx" ON "PartnerLinkAudit"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerLinkAudit_accountId_idx" ON "PartnerLinkAudit"("accountId");

-- AddForeignKey
ALTER TABLE "PartnerLinkAudit" ADD CONSTRAINT "PartnerLinkAudit_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Add new columns, all NULLABLE for now
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "User" ADD COLUMN "teamId" TEXT;

-- AlterTable
ALTER TABLE "Stage" ADD COLUMN "teamId" TEXT;

-- AlterTable
ALTER TABLE "AccountFieldDef" ADD COLUMN "teamId" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "teamId" TEXT,
                  ADD COLUMN "buildingKey" TEXT,
                  ADD COLUMN "wonAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "teamId" TEXT,
                      ADD COLUMN "buildingKey" TEXT;

-- Field-def label uniqueness moves from company scope to team scope.
--
-- DROPPED HERE, BEFORE THE BACKFILL, NOT WITH THE OTHER DROPS IN SECTION 5. Step 3.6 inserts a
-- teamId-NULL template copy of every existing AccountFieldDef row, which necessarily repeats its
-- original's (companyId, label). While this index still exists that copy violates it, which is
-- exactly how an earlier revision of this file failed on dev.
-- DropIndex
DROP INDEX "AccountFieldDef_companyId_label_key";

-- ---------------------------------------------------------------------------
-- 3. Backfill
-- ---------------------------------------------------------------------------

-- 3.1 One team per company. gen_random_uuid()::text rather than a cuid because SQL cannot mint a
-- cuid; the column is a plain TEXT id so the two coexist. Team is brand new, so a pre-existing
-- team of this name cannot collide with the unique (companyId, name).
INSERT INTO "Team" ("id", "companyId", "name", "createdAt")
SELECT gen_random_uuid()::text, c."id", 'Sales Team 1', CURRENT_TIMESTAMP
FROM "Company" c;

-- 3.2 Users. Only COMPANY_ADMIN and MEMBER join a team.
-- SUPER_ADMIN stays NULL (it sees every team) and so does PARTNER_VIEWER (scoped to a single
-- Account via accountId, never to a team). SUPER_ADMIN additionally has a NULL companyId, so the
-- join below would not match it even without the role filter. No SUPER_ADMIN is created here --
-- prod has none, and a later task adds one.
UPDATE "User" u
SET "teamId" = t."id"
FROM "Team" t
WHERE t."companyId" = u."companyId"
  AND t."name" = 'Sales Team 1'
  AND u."role" IN ('COMPANY_ADMIN', 'MEMBER');

-- 3.3 Every lead and account joins its company's team.
UPDATE "Lead" l
SET "teamId" = t."id"
FROM "Team" t
WHERE t."companyId" = l."companyId" AND t."name" = 'Sales Team 1';

UPDATE "Account" a
SET "teamId" = t."id"
FROM "Team" t
WHERE t."companyId" = a."companyId" AND t."name" = 'Sales Team 1';

-- 3.4 Building claim keys.
--
-- NFKC-normalize, trim, collapse internal whitespace runs to one space, lowercase. Source is
-- COALESCE(companyName, title) for a lead and name for an account.
--
-- The NULLIF(..., '') fallback to the row's own id covers a name that normalizes to the empty
-- string (whitespace-only). Without it two such rows would collide on the unique index and abort
-- the whole deploy. A cuid-shaped key is inert -- nobody will ever type it, so it claims no real
-- building -- and the app overwrites it with the correct key on the row's next write. Dev has 0
-- such rows; see the report for the query to count them before deploying anywhere else.
UPDATE "Lead" l
SET "buildingKey" = COALESCE(
      NULLIF(lower(regexp_replace(btrim(normalize(COALESCE(l."companyName", l."title"), NFKC)), '\s+', ' ', 'g')), ''),
      l."id"
    );

UPDATE "Account" a
SET "buildingKey" = COALESCE(
      NULLIF(lower(regexp_replace(btrim(normalize(a."name", NFKC)), '\s+', ' ', 'g')), ''),
      a."id"
    );

-- 3.5 wonAt for leads currently sitting in a WON-type stage.
--
-- Prefer the converted account's createdAt (the real moment of the win) and fall back to the
-- lead's updatedAt. This is what replaces the old updatedAt-based "won in period" metric, which
-- re-counted an old won lead into the current period whenever anyone edited it.
-- Account.sourceLeadId is UNIQUE, so the scalar subquery yields at most one row.
UPDATE "Lead" l
SET "wonAt" = COALESCE(
      (SELECT ac."createdAt" FROM "Account" ac WHERE ac."sourceLeadId" = l."id"),
      l."updatedAt"
    )
WHERE EXISTS (
  SELECT 1 FROM "Stage" s WHERE s."id" = l."stageId" AND s."type" = 'WON'
);

-- 3.6 Stages and account field definitions: the rows that exist today become the default team's
-- own set, then a copy of each is inserted with teamId NULL to become the org-level template that
-- a newly created team gets seeded from.
--
-- The template is per COMPANY (companyId is NOT NULL and cascades to Company, so a template row
-- must belong to one). Collapsing to a single global template is only meaningful once the org is
-- a single Company, which is the end state of this refactor, not of this migration.
UPDATE "Stage" s
SET "teamId" = t."id"
FROM "Team" t
WHERE t."companyId" = s."companyId" AND t."name" = 'Sales Team 1';

UPDATE "AccountFieldDef" d
SET "teamId" = t."id"
FROM "Team" t
WHERE t."companyId" = d."companyId" AND t."name" = 'Sales Team 1';

-- INSERT ... SELECT over the same table reads the statement's starting snapshot, so these do not
-- re-read their own output. The teamId IS NOT NULL filter therefore selects exactly the rows the
-- two UPDATEs above just claimed.
INSERT INTO "Stage" ("id", "companyId", "teamId", "name", "order", "type", "probability", "createdAt")
SELECT gen_random_uuid()::text, s."companyId", NULL, s."name", s."order", s."type", s."probability", s."createdAt"
FROM "Stage" s
WHERE s."teamId" IS NOT NULL;

INSERT INTO "AccountFieldDef" ("id", "companyId", "teamId", "label", "type", "order", "createdAt")
SELECT gen_random_uuid()::text, d."companyId", NULL, d."label", d."type", d."order", d."createdAt"
FROM "AccountFieldDef" d
WHERE d."teamId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Contract: the backfilled columns become NOT NULL
-- ---------------------------------------------------------------------------

ALTER TABLE "Lead" ALTER COLUMN "teamId" SET NOT NULL,
                   ALTER COLUMN "buildingKey" SET NOT NULL;

ALTER TABLE "Account" ALTER COLUMN "teamId" SET NOT NULL,
                      ALTER COLUMN "buildingKey" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Drops
-- ---------------------------------------------------------------------------

-- Member isolation is absolute now, not configurable per company.
-- DATA LOSS: the per-company flag is gone. Every company in dev held the default `true`.
-- AlterTable
ALTER TABLE "Company" DROP COLUMN "shareAllLeads";

-- The allowlist existed to stop one tenant claiming another tenant's complex by name. With a
-- single org there is no cross-tenant claim to prevent, and the building claim
-- (companyId, buildingKey) now covers intra-org contention.
-- DATA LOSS: all grant rows are destroyed. Dev and test both hold 0 rows.
-- DropForeignKey
ALTER TABLE "PartnerAllowlist" DROP CONSTRAINT "PartnerAllowlist_companyId_fkey";

-- DropTable
DROP TABLE "PartnerAllowlist";

-- (AccountFieldDef_companyId_label_key is dropped up in section 2 -- see the note there.)

-- ---------------------------------------------------------------------------
-- 6. Indexes, unique constraints, remaining foreign keys
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "User_companyId_teamId_idx" ON "User"("companyId", "teamId");

-- CreateIndex
CREATE INDEX "Stage_companyId_teamId_idx" ON "Stage"("companyId", "teamId");

-- CreateIndex
CREATE INDEX "Lead_companyId_teamId_idx" ON "Lead"("companyId", "teamId");

-- CreateIndex
CREATE INDEX "Lead_teamId_ownerId_idx" ON "Lead"("teamId", "ownerId");

-- CreateIndex
CREATE INDEX "Lead_companyId_wonAt_idx" ON "Lead"("companyId", "wonAt");

-- A LOST lead KEEPS its building claim (owner decision), so this is a plain unique index and
-- deliberately NOT stage-aware.
-- CreateIndex
CREATE UNIQUE INDEX "Lead_companyId_buildingKey_key" ON "Lead"("companyId", "buildingKey");

-- CreateIndex
CREATE INDEX "Account_companyId_teamId_idx" ON "Account"("companyId", "teamId");

-- CreateIndex
CREATE INDEX "Account_teamId_accountManagerId_idx" ON "Account"("teamId", "accountManagerId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_companyId_buildingKey_key" ON "Account"("companyId", "buildingKey");

-- CreateIndex
CREATE INDEX "AccountFieldDef_companyId_teamId_idx" ON "AccountFieldDef"("companyId", "teamId");

-- Postgres treats NULLs as DISTINCT, so this does NOT police the org-level template
-- (teamId IS NULL). Template label uniqueness is an app-code rule -- see the report.
-- CreateIndex
CREATE UNIQUE INDEX "AccountFieldDef_teamId_label_key" ON "AccountFieldDef"("teamId", "label");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountFieldDef" ADD CONSTRAINT "AccountFieldDef_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not SET NULL: teamId is NOT NULL on both, so a team holding leads or accounts cannot
-- be deleted until they are moved.
-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- accountManagerId becomes a real relation. This FK will REJECT the migration if any account
-- points at a user id that no longer exists -- dev has 0 such rows; verify before deploying
-- anywhere else (query in the report).
-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_accountManagerId_fkey" FOREIGN KEY ("accountManagerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
