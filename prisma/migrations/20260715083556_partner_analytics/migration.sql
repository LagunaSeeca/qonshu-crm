-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'MANUAL', 'CASH');

-- CreateEnum
CREATE TYPE "PaymentCategory" AS ENUM ('APARTMENT', 'PARKING', 'NON_RESIDENTIAL', 'UTILITY');

-- CreateTable
CREATE TABLE "PartnerAppUser" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "debt" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerAppUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "appUserId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "category" "PaymentCategory" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerAppUser_companyId_accountId_idx" ON "PartnerAppUser"("companyId", "accountId");

-- CreateIndex
CREATE INDEX "PartnerAppUser_accountId_active_idx" ON "PartnerAppUser"("accountId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAppUser_accountId_externalId_key" ON "PartnerAppUser"("accountId", "externalId");

-- CreateIndex
CREATE INDEX "PartnerPayment_companyId_accountId_idx" ON "PartnerPayment"("companyId", "accountId");

-- CreateIndex
CREATE INDEX "PartnerPayment_accountId_occurredAt_idx" ON "PartnerPayment"("accountId", "occurredAt");

-- AddForeignKey
ALTER TABLE "PartnerAppUser" ADD CONSTRAINT "PartnerAppUser_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerAppUser" ADD CONSTRAINT "PartnerAppUser_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPayment" ADD CONSTRAINT "PartnerPayment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPayment" ADD CONSTRAINT "PartnerPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPayment" ADD CONSTRAINT "PartnerPayment_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES "PartnerAppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
