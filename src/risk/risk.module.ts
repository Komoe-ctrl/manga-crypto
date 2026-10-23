import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RiskController } from './risk.controller.js';
import { RiskSettingsService } from './risk-settings.service.js';
import { TradingControlService } from './trading-control.service.js';

@Module({
  imports: [AuthModule],
  controllers: [RiskController],
  providers: [RiskSettingsService, TradingControlService],
  exports: [TradingControlService, RiskSettingsService],
})
export class RiskModule {}
