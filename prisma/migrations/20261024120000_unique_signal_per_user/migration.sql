-- DropIndex
DROP INDEX "trade_logs_signalStreamId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "trade_logs_userId_signalStreamId_key" ON "trade_logs"("userId", "signalStreamId");

