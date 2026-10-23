import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { PortfolioModule } from '../../portfolio/portfolio.module.js';
import { backgroundJobsEnabled } from '../../queue/queue.module.js';
import { NotificationsModule } from '../notifications.module.js';
import { AlertEvaluator } from './alert-evaluator.js';
import {
  ALERTS_ENGINE_QUEUE,
  AlertsEngineProcessor,
  AlertsEngineScheduler,
} from './alerts-engine.processor.js';

/**
 * Moteur d'évaluation des alertes (job BullMQ répétable, une minute). Désactivé avec `BACKGROUND_JOBS_ENABLED=false`.
 * La connexion Redis est celle du `QueueModule`.
 */
@Module({})
export class AlertsEngineModule {
  static register(): DynamicModule {
    if (!backgroundJobsEnabled()) return { module: AlertsEngineModule };

    return {
      module: AlertsEngineModule,
      imports: [
        BullModule.registerQueue({
          name: ALERTS_ENGINE_QUEUE,
          defaultJobOptions: {
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 100 },
          },
        }),
        PortfolioModule,
        NotificationsModule,
      ],
      providers: [AlertEvaluator, AlertsEngineProcessor, AlertsEngineScheduler],
    };
  }
}
