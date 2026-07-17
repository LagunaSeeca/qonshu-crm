-- CreateEnum
CREATE TYPE "AccountFieldType" AS ENUM ('TEXT', 'NUMBER', 'CURRENCY', 'DATE');

-- CreateTable
CREATE TABLE "AccountFieldDef" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "AccountFieldType" NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountFieldDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountFieldValue" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fieldDefId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountFieldDef_companyId_idx" ON "AccountFieldDef"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountFieldDef_companyId_label_key" ON "AccountFieldDef"("companyId", "label");

-- CreateIndex
CREATE INDEX "AccountFieldValue_companyId_accountId_idx" ON "AccountFieldValue"("companyId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountFieldValue_accountId_fieldDefId_key" ON "AccountFieldValue"("accountId", "fieldDefId");

-- AddForeignKey
ALTER TABLE "AccountFieldDef" ADD CONSTRAINT "AccountFieldDef_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountFieldValue" ADD CONSTRAINT "AccountFieldValue_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountFieldValue" ADD CONSTRAINT "AccountFieldValue_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountFieldValue" ADD CONSTRAINT "AccountFieldValue_fieldDefId_fkey" FOREIGN KEY ("fieldDefId") REFERENCES "AccountFieldDef"("id") ON DELETE CASCADE ON UPDATE CASCADE;
