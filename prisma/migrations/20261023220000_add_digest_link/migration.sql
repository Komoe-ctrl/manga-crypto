-- AlterEnum
ALTER TYPE "NotificationStatus" ADD VALUE 'DIGESTED';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "digestId" TEXT;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "digest_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

