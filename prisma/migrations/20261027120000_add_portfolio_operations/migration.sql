-- CreateEnum
CREATE TYPE "OperationKind" AS ENUM ('BUY', 'SELL', 'SET', 'REMOVE');

-- CreateEnum
CREATE TYPE "OperationSource" AS ENUM ('DECLARED', 'ORDER');

-- CreateTable
CREATE TABLE "portfolio_operations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "kind" "OperationKind" NOT NULL,
    "source" "OperationSource" NOT NULL DEFAULT 'DECLARED',
    "quantity" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(38,8) NOT NULL,
    "realizedPnl" DECIMAL(38,18),
    "orderId" TEXT,
    "showInHistory" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portfolio_operations_userId_createdAt_idx" ON "portfolio_operations"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "portfolio_operations_userId_symbol_createdAt_idx" ON "portfolio_operations"("userId", "symbol", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "portfolio_operations" ADD CONSTRAINT "portfolio_operations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

