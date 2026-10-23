import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PortfolioModule } from '../portfolio/portfolio.module.js';
import { backgroundJobsEnabled } from '../queue/queue.module.js';
import {
  DIGEST_QUEUE,
  DigestEngineProcessor,
  DigestEngineScheduler,
} from './digest-engine.processor.js';
import { DigestGenerator } from './digest.generator.js';

/**
 * Génération du rapport du matin (job BullMQ répétable, 5 minutes). Désactivée avec `BACKGROUND_JOBS_ENABLED=false`.
 * La connexion Redis est celle du `QueueModule`.
 */
@Module({})
export class DigestEngineModule {
  static register(): DynamicModule {
    if (!backgroundJobsEnabled()) return { module: DigestEngineModule };

    return {
      module: DigestEngineModule,
      imports: [
        BullModule.registerQueue({
          name: DIGEST_QUEUE,
          defaultJobOptions: {
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 100 },
          },
        }),
        PortfolioModule,
        NotificationsModule,
      ],
      providers: [
        DigestGenerator,
        DigestEngineProcessor,
        DigestEngineScheduler,
      ],
    };
  }
}
