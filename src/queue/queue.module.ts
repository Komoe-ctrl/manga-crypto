import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { RedisConnection, RedisConnectionModule } from './redis-connection.js';

/**
 * Les jobs de fond (BullMQ) sont actifs par défaut. `BACKGROUND_JOBS_ENABLED=false` les désactive tous
 * (tests, ou instance qui ne doit pas les exécuter) : aucune connexion Redis n'est alors ouverte.
 */
export const backgroundJobsEnabled = (): boolean =>
  process.env.BACKGROUND_JOBS_ENABLED !== 'false';

/**
 * Connexion BullMQ unique, partagée par toutes les files (perte journalière, alertes…). À importer une seule
 * fois (dans AppModule) ; les modules de jobs n'ont plus qu'à déclarer leur file avec `BullModule.registerQueue`.
 */
@Module({})
export class QueueModule {
  static register(): DynamicModule {
    if (!backgroundJobsEnabled()) return { module: QueueModule };

    return {
      module: QueueModule,
      imports: [
        BullModule.forRootAsync({
          imports: [RedisConnectionModule],
          inject: [RedisConnection],
          useFactory: (redis: RedisConnection) => ({
            connection: redis.client,
          }),
        }),
      ],
    };
  }
}
