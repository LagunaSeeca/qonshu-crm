-- CreateEnum
CREATE TYPE "ServiceFeeStatus" AS ENUM ('UNPAID', 'PAID');

-- CreateTable
CREATE TABLE "ServiceFee" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "periodMonth" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" "ServiceFeeStatus" NOT NULL DEFAULT 'UNPAID',
    "paidAt" TIMESTAMP(3),
    "method" "SettlementMethod",
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceFee_companyId_status_idx" ON "ServiceFee"("companyId", "status");

-- CreateIndex
CREATE INDEX "ServiceFee_companyId_accountId_idx" ON "ServiceFee"("companyId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceFee_accountId_periodMonth_key" ON "ServiceFee"("accountId", "periodMonth");

-- AddForeignKey
ALTER TABLE "ServiceFee" ADD CONSTRAINT "ServiceFee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceFee" ADD CONSTRAINT "ServiceFee_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
