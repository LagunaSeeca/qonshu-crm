-- CreateTable
CREATE TABLE "PartnerAllowlist" (
    "id" TEXT NOT NULL,
    "partnerName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerAllowlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAllowlist_partnerName_key" ON "PartnerAllowlist"("partnerName");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAllowlist_normalizedName_key" ON "PartnerAllowlist"("normalizedName");

-- CreateIndex
CREATE INDEX "PartnerAllowlist_companyId_idx" ON "PartnerAllowlist"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_externalPartnerKey_key" ON "Account"("externalPartnerKey");

-- AddForeignKey
ALTER TABLE "PartnerAllowlist" ADD CONSTRAINT "PartnerAllowlist_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

