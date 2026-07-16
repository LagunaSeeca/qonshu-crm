/*
  Warnings:

  - Made the column `method` on table `SettlementEntry` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
ALTER TYPE "SettlementMethod" ADD VALUE 'MANUAL';

-- Backfill existing NULL methods before enforcing NOT NULL
UPDATE "SettlementEntry" SET "method"='CASH' WHERE "method" IS NULL;

-- AlterTable
ALTER TABLE "SettlementEntry" ALTER COLUMN "method" SET NOT NULL;
