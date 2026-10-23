-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "Exchange" AS ENUM ('BINANCE', 'KRAKEN');

-- CreateEnum
CREATE TYPE "ExchangeStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertCondition" AS ENUM ('PRICE_DROP_PCT', 'PRICE_RISE_PCT', 'PRICE_CROSS_ABOVE', 'PRICE_CROSS_BELOW', 'PORTFOLIO_DROP_PCT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'TELEGRAM', 'EMAIL');

-- CreateEnum
CREATE TYPE "DigestPeriod" AS ENUM ('TODAY', 'YESTERDAY', 'WEEK');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "baseCurrency" TEXT NOT NULL DEFAULT 'USD',
    "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "tradingModeChangedAt" TIMESTAMP(3),
    "killSwitchActive" BOOLEAN NOT NULL DEFAULT false,
    "killSwitchAt" TIMESTAMP(3),
    "botPausedUntil" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nightModeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nightStartMinute" INTEGER NOT NULL DEFAULT 1320,
    "nightEndMinute" INTEGER NOT NULL DEFAULT 420,
    "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "digestMinute" INTEGER NOT NULL DEFAULT 480,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pushSubscription" JSONB,
    "telegramChatId" TEXT,
    "notificationEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchange" "Exchange" NOT NULL,
    "label" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "apiKeyCipher" TEXT NOT NULL,
    "apiKeyIv" TEXT NOT NULL,
    "apiKeyTag" TEXT NOT NULL,
    "apiSecretCipher" TEXT NOT NULL,
    "apiSecretIv" TEXT NOT NULL,
    "apiSecretTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "apiKeyHint" TEXT NOT NULL,
    "status" "ExchangeStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "permissions" TEXT[],
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maxExposurePct" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "maxDailyLossPct" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "defaultStopLossPct" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "defaultTakeProfitPct" DECIMAL(5,2) NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "avgBuyPrice" DECIMAL(38,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchangeConfigId" TEXT,
    "clientOrderId" TEXT NOT NULL,
    "exchangeOrderId" TEXT,
    "mode" "TradingMode" NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL DEFAULT 'MARKET',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "quantity" DECIMAL(38,18) NOT NULL,
    "filledQuantity" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "price" DECIMAL(38,8),
    "avgFillPrice" DECIMAL(38,8),
    "fee" DECIMAL(38,18),
    "feeCurrency" TEXT,
    "stopLossPrice" DECIMAL(38,8),
    "takeProfitPrice" DECIMAL(38,8),
    "signalStreamId" TEXT,
    "signalPayload" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "trade_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetSymbol" TEXT,
    "condition" "AlertCondition" NOT NULL,
    "threshold" DECIMAL(38,8) NOT NULL,
    "windowMinutes" INTEGER,
    "channel" "NotificationChannel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isCritical" BOOLEAN NOT NULL DEFAULT false,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digest_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" "DigestPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "points" TEXT[],
    "portfolioDeltaPct" DECIMAL(7,2),
    "queuedAlertsCount" INTEGER NOT NULL DEFAULT 0,
    "readAt" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digest_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(64),
    "entityId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_userId_key" ON "notification_settings"("userId");

-- CreateIndex
CREATE INDEX "exchange_configs_userId_status_idx" ON "exchange_configs"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_configs_userId_exchange_label_key" ON "exchange_configs"("userId", "exchange", "label");

-- CreateIndex
CREATE UNIQUE INDEX "risk_settings_userId_key" ON "risk_settings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_userId_symbol_key" ON "assets"("userId", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "trade_logs_clientOrderId_key" ON "trade_logs"("clientOrderId");

-- CreateIndex
CREATE INDEX "trade_logs_userId_createdAt_idx" ON "trade_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "trade_logs_status_idx" ON "trade_logs"("status");

-- CreateIndex
CREATE INDEX "trade_logs_signalStreamId_idx" ON "trade_logs"("signalStreamId");

-- CreateIndex
CREATE INDEX "alert_configs_userId_isActive_idx" ON "alert_configs"("userId", "isActive");

-- CreateIndex
CREATE INDEX "alert_configs_assetSymbol_isActive_idx" ON "alert_configs"("assetSymbol", "isActive");

-- CreateIndex
CREATE INDEX "digest_reports_userId_generatedAt_idx" ON "digest_reports"("userId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "digest_reports_userId_period_periodStart_key" ON "digest_reports"("userId", "period", "periodStart");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_configs" ADD CONSTRAINT "exchange_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_settings" ADD CONSTRAINT "risk_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_logs" ADD CONSTRAINT "trade_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_logs" ADD CONSTRAINT "trade_logs_exchangeConfigId_fkey" FOREIGN KEY ("exchangeConfigId") REFERENCES "exchange_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_configs" ADD CONSTRAINT "alert_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digest_reports" ADD CONSTRAINT "digest_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Journal d'audit immuable : interdit UPDATE, DELETE et TRUNCATE (SPEC section 4.4).
CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs est immuable : % interdit', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
