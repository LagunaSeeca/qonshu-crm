-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'AT_RISK', 'CHURNED');

-- CreateEnum
CREATE TYPE "AccountActivityKind" AS ENUM ('NOTE', 'CALL', 'MEETING', 'EMAIL');

-- CreateEnum
CREATE TYPE "AskStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "industry" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "accountManagerId" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "primaryContactName" TEXT,
    "primaryContactEmail" TEXT,
    "primaryContactPhone" TEXT,
    "sourceLeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountActivity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "authorId" TEXT,
    "kind" "AccountActivityKind" NOT NULL DEFAULT 'NOTE',
    "body" TEXT NOT NULL,
    "outcome" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountTask" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "assigneeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAsk" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "status" "AskStatus" NOT NULL DEFAULT 'OPEN',
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AccountAsk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAttachment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "diskPath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_sourceLeadId_key" ON "Account"("sourceLeadId");

-- CreateIndex
CREATE INDEX "Account_companyId_idx" ON "Account"("companyId");

-- CreateIndex
CREATE INDEX "Account_companyId_status_idx" ON "Account"("companyId", "status");

-- CreateIndex
CREATE INDEX "Account_companyId_accountManagerId_idx" ON "Account"("companyId", "accountManagerId");

-- CreateIndex
CREATE INDEX "AccountActivity_companyId_accountId_idx" ON "AccountActivity"("companyId", "accountId");

-- CreateIndex
CREATE INDEX "AccountTask_companyId_accountId_idx" ON "AccountTask"("companyId", "accountId");

-- CreateIndex
CREATE INDEX "AccountAsk_companyId_accountId_idx" ON "AccountAsk"("companyId", "accountId");

-- CreateIndex
CREATE INDEX "AccountAttachment_companyId_accountId_idx" ON "AccountAttachment"("companyId", "accountId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountActivity" ADD CONSTRAINT "AccountActivity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountActivity" ADD CONSTRAINT "AccountActivity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountTask" ADD CONSTRAINT "AccountTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountTask" ADD CONSTRAINT "AccountTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAsk" ADD CONSTRAINT "AccountAsk_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAsk" ADD CONSTRAINT "AccountAsk_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAttachment" ADD CONSTRAINT "AccountAttachment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAttachment" ADD CONSTRAINT "AccountAttachment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
