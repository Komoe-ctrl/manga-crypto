import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { PortfolioModule } from '../../portfolio/portfolio.module.js';
import { backgroundJobsEnabled } from '../../queue/queue.module.js';
import { DailyLossMonitor } from './daily-loss.monitor.js';
import {
  RISK_MONITOR_QUEUE,
  RiskMonitorProcessor,
  RiskMonitorScheduler,
} from './risk-monitor.processor.js';

/**
 * Surveillance de la perte journalière (job BullMQ répétable). Désactivée avec `BACKGROUND_JOBS_ENABLED=false`.
 * La connexion Redis est celle du `QueueModule`.
 */
@Module({})
export class RiskMonitorModule {
  static register(): DynamicModule {
    if (!backgroundJobsEnabled()) return { module: RiskMonitorModule };

    return {
      module: RiskMonitorModule,
      imports: [
        BullModule.registerQueue({
          name: RISK_MONITOR_QUEUE,
          defaultJobOptions: {
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 100 },
          },
        }),
        PortfolioModule,
        NotificationsModule,
      ],
      providers: [DailyLossMonitor, RiskMonitorProcessor, RiskMonitorScheduler],
    };
  }
}
