-- CreateEnum
CREATE TYPE "OrderOrigin" AS ENUM ('MANUAL', 'SIGNAL', 'STOP_LOSS', 'TAKE_PROFIT');

-- AlterTable
ALTER TABLE "trade_logs" ADD COLUMN     "exitTriggeredAt" TIMESTAMP(3),
ADD COLUMN     "origin" "OrderOrigin" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "parentOrderId" TEXT;

-- CreateIndex
CREATE INDEX "trade_logs_parentOrderId_idx" ON "trade_logs"("parentOrderId");

-- AddForeignKey
ALTER TABLE "trade_logs" ADD CONSTRAINT "trade_logs_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "trade_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

