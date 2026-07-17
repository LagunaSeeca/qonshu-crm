-- CreateEnum
CREATE TYPE "AppPlatform" AS ENUM ('IOS', 'ANDROID', 'UNKNOWN');

-- AlterTable
ALTER TABLE "PartnerAppUser" ADD COLUMN     "appToken" TEXT,
ADD COLUMN     "installedAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "platform" "AppPlatform" NOT NULL DEFAULT 'UNKNOWN';
