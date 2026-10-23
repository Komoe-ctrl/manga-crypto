import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { PortfolioModule } from '../../portfolio/portfolio.module.js';
import { DailyLossMonitor } from './daily-loss.monitor.js';
import { RedisConnection, RedisConnectionModule } from './redis-connection.js';
import {
  RISK_MONITOR_QUEUE,
  RiskMonitorProcessor,
  RiskMonitorScheduler,
} from './risk-monitor.processor.js';

/**
 * Surveillance de la perte journalière (job BullMQ répétable). Désactivable avec `RISK_MONITOR_ENABLED=false`
 * (tests, ou instance qui ne doit pas exécuter les jobs) : aucune connexion Redis n'est alors ouverte.
 */
@Module({})
export class RiskMonitorModule {
  static register(): DynamicModule {
    if (process.env.RISK_MONITOR_ENABLED === 'false')
      return { module: RiskMonitorModule };

    return {
      module: RiskMonitorModule,
      imports: [
        BullModule.forRootAsync({
          imports: [RedisConnectionModule],
          inject: [RedisConnection],
          useFactory: (redis: RedisConnection) => ({
            connection: redis.client,
          }),
        }),
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
