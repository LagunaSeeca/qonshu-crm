-- Enum values for the DEMO-trial / onboarding feature. This file is deliberately ONLY these two
-- statements, with no BEGIN/COMMIT and nothing that USES either new value.
--
-- WHY: on PostgreSQL 12+ `ALTER TYPE ... ADD VALUE` may run inside a transaction block, but the
-- new value cannot be USED until that transaction commits (Postgres raises "unsafe use of new
-- value"). Before PG 12 it cannot run in a transaction at all. Keeping these two statements alone
-- and autocommitted is therefore safe on every version, and it is what lets the NEXT migration
-- (20261124090100_demo_trials_assignments_onboarding) reference 'DEMO' in a CHECK constraint.
-- IF NOT EXISTS makes a re-run after a partial failure harmless.

-- AlterEnum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ONBOARDING';

-- AlterEnum
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'DEMO';
