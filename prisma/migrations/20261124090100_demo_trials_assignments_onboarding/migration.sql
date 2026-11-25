-- DEMO / trial accounts, building assignments, and the post-contract onboarding checklist.
--
-- HAND-EDITED from `prisma migrate diff`. The generated script is one flat list; this file puts
-- the statements in dependency order (columns -> backfill -> CHECK -> new tables -> indexes ->
-- foreign keys) so the backfill and the CHECK see the new columns.
--
-- DEPENDS ON 20261124090000_role_onboarding_account_demo_enums having COMMITTED. The CHECK in
-- step 3 references the enum value 'DEMO'; Postgres refuses to use a value added by ALTER TYPE
-- in the same transaction ("unsafe use of new value"), which is why the two ALTER TYPE
-- statements live in their own file. The "Role" value 'ONBOARDING' is not referenced here.
--
-- WRAPPED IN AN EXPLICIT TRANSACTION. Prisma Migrate does NOT wrap a migration file in one, and
-- this repo has already been left half-applied by a failed migration (see
-- 20261030120000_org_teams_building_claim_partner_audit). Postgres has transactional DDL, so
-- BEGIN/COMMIT makes this all-or-nothing.
--
-- No data loss: only additive changes. The only data write is the onboardingSeededAt backfill.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New Account columns (all nullable, so no default/backfill is needed to add them)
-- ---------------------------------------------------------------------------

-- AlterTable
-- trialStartsAt / trialEndsAt are DATE (calendar days), not timestamps, to avoid time-zone
-- off-by-one errors in "N days left".
ALTER TABLE "Account" ADD COLUMN     "onboardingSeededAt" TIMESTAMP(3),
ADD COLUMN     "takesOnlinePayments" BOOLEAN,
ADD COLUMN     "trialEndsAt" DATE,
ADD COLUMN     "trialStartsAt" DATE;

-- ---------------------------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------------------------

-- Every PRE-EXISTING account counts as already past onboarding, so a legacy AT_RISK -> ACTIVE
-- status change never seeds a surprise checklist on an old customer. onboardingSeededAt is the
-- idempotency claim the seeder checks.
UPDATE "Account" SET "onboardingSeededAt" = "createdAt";

-- ---------------------------------------------------------------------------
-- 3. CHECK: a DEMO account must carry a valid trial window
-- ---------------------------------------------------------------------------

-- Prisma does not model CHECK constraints, so this will not appear in schema.prisma or in a
-- later `migrate diff`. Depends on 'DEMO' having been committed by the previous migration.
ALTER TABLE "Account" ADD CONSTRAINT "Account_demo_trial_dates_check" CHECK ("status" <> 'DEMO' OR ("trialStartsAt" IS NOT NULL AND "trialEndsAt" IS NOT NULL AND "trialEndsAt" >= "trialStartsAt"));

-- ---------------------------------------------------------------------------
-- 4. New tables, indexes, foreign keys
-- ---------------------------------------------------------------------------

-- CreateTable
-- AUTHORIZATION INPUT: a row grants userId access to accountId. userId cascades on purpose, so
-- deleting a user revokes their access. createdById is an informational bare id (no FK).
CREATE TABLE "AccountAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- completedById / assigneeId / createdById are bare ids with no FK, deliberately: deleting a
-- user must never be blocked by, or cascade through, checklist data.
CREATE TABLE "OnboardingStep" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "templateKey" TEXT,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "dueDate" DATE,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountAssignment_userId_accountId_idx" ON "AccountAssignment"("userId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountAssignment_accountId_userId_key" ON "AccountAssignment"("accountId", "userId");

-- CreateIndex
CREATE INDEX "OnboardingStep_accountId_position_idx" ON "OnboardingStep"("accountId", "position");

-- CreateIndex
CREATE INDEX "OnboardingStep_companyId_assigneeId_done_idx" ON "OnboardingStep"("companyId", "assigneeId", "done");

-- DB backstop against seeding the checklist twice. Postgres treats NULLs as distinct, so any
-- number of custom (templateKey IS NULL) steps coexist.
-- CreateIndex
CREATE UNIQUE INDEX "OnboardingStep_accountId_templateKey_key" ON "OnboardingStep"("accountId", "templateKey");

-- For the "trials expiring soon" list.
-- CreateIndex
CREATE INDEX "Account_companyId_status_trialEndsAt_idx" ON "Account"("companyId", "status", "trialEndsAt");

-- AddForeignKey
ALTER TABLE "AccountAssignment" ADD CONSTRAINT "AccountAssignment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAssignment" ADD CONSTRAINT "AccountAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAssignment" ADD CONSTRAINT "AccountAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
