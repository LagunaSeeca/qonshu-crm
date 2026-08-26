-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "externalApiKeyEnc" TEXT,
ADD COLUMN     "externalApiKeyLast4" TEXT;

-- CreateTable
CREATE TABLE "PlatformInstallSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "capturedOn" DATE NOT NULL,
    "iosInstalls" INTEGER NOT NULL,
    "androidInstalls" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformInstallSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformInstallSnapshot_companyId_capturedOn_idx" ON "PlatformInstallSnapshot"("companyId", "capturedOn");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInstallSnapshot_accountId_capturedOn_key" ON "PlatformInstallSnapshot"("accountId", "capturedOn");

-- AddForeignKey
ALTER TABLE "PlatformInstallSnapshot" ADD CONSTRAINT "PlatformInstallSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInstallSnapshot" ADD CONSTRAINT "PlatformInstallSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInstallSnapshot" ADD CONSTRAINT "PlatformInstallSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
