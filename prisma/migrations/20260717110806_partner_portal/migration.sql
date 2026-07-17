-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'PARTNER_VIEWER';

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "accountId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountId" TEXT;

-- CreateIndex
CREATE INDEX "User_accountId_idx" ON "User"("accountId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
