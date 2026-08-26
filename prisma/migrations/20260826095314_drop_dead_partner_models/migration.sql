-- DropForeignKey
ALTER TABLE "PartnerAppUser" DROP CONSTRAINT "PartnerAppUser_companyId_fkey";

-- DropForeignKey
ALTER TABLE "PartnerAppUser" DROP CONSTRAINT "PartnerAppUser_accountId_fkey";

-- DropForeignKey
ALTER TABLE "AccountDebtSnapshot" DROP CONSTRAINT "AccountDebtSnapshot_companyId_fkey";

-- DropForeignKey
ALTER TABLE "AccountDebtSnapshot" DROP CONSTRAINT "AccountDebtSnapshot_accountId_fkey";

-- DropForeignKey
ALTER TABLE "PartnerPayment" DROP CONSTRAINT "PartnerPayment_companyId_fkey";

-- DropForeignKey
ALTER TABLE "PartnerPayment" DROP CONSTRAINT "PartnerPayment_accountId_fkey";

-- DropForeignKey
ALTER TABLE "PartnerPayment" DROP CONSTRAINT "PartnerPayment_appUserId_fkey";

-- DropTable
DROP TABLE "PartnerAppUser";

-- DropTable
DROP TABLE "AccountDebtSnapshot";

-- DropTable
DROP TABLE "PartnerPayment";

-- DropEnum
DROP TYPE "PaymentMethod";

-- DropEnum
DROP TYPE "PaymentCategory";
