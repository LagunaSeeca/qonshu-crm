-- CreateTable
CREATE TABLE "AccountDebtSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "capturedOn" DATE NOT NULL,
    "totalDebt" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDebtSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDebtSnapshot_companyId_capturedOn_idx" ON "AccountDebtSnapshot"("companyId", "capturedOn");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDebtSnapshot_accountId_capturedOn_key" ON "AccountDebtSnapshot"("accountId", "capturedOn");

-- AddForeignKey
ALTER TABLE "AccountDebtSnapshot" ADD CONSTRAINT "AccountDebtSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDebtSnapshot" ADD CONSTRAINT "AccountDebtSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
