import { type DynamicModule, Module } from '@nestjs/common';
import { backgroundJobsEnabled } from '../queue/queue.module.js';
import { RedisConnectionModule } from '../queue/redis-connection.js';
import { HealthController } from './health.controller.js';

/**
 * Redis n'est vérifié que si les jobs de fond l'utilisent : sans eux, aucune connexion Redis n'est ouverte
 * (tests, instance sans jobs) et la sonde ne doit pas en ouvrir une.
 */
@Module({})
export class HealthModule {
  static register(): DynamicModule {
    return {
      module: HealthModule,
      imports: backgroundJobsEnabled() ? [RedisConnectionModule] : [],
      controllers: [HealthController],
    };
  }
}
