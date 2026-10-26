import { type DynamicModule, Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { PortfolioModule } from '../portfolio/portfolio.module.js';
import {
  RedisConnection,
  RedisConnectionModule,
} from '../queue/redis-connection.js';
import { backgroundJobsEnabled } from '../queue/queue.module.js';
import { RiskModule } from '../risk/risk.module.js';
import { SignalConsumer } from './signal.consumer.js';
import { SignalHandler } from './signal.handler.js';
import { RedisSignalStream, SignalStream } from './signal-stream.js';

/**
 * Consommation des signaux du moteur (Redis Stream `signals`). Désactivée avec `BACKGROUND_JOBS_ENABLED=false`
 * (aucune connexion Redis n'est alors ouverte).
 */
@Module({})
export class SignalsModule {
  static register(): DynamicModule {
    if (!backgroundJobsEnabled()) return { module: SignalsModule };

    return {
      module: SignalsModule,
      imports: [
        RedisConnectionModule,
        PortfolioModule,
        RiskModule,
        OrdersModule.register(),
      ],
      providers: [
        SignalHandler,
        SignalConsumer,
        {
          provide: SignalStream,
          inject: [RedisConnection],
          // Connexion dédiée : XREADGROUP BLOCK bloquerait la connexion partagée de BullMQ.
          useFactory: (redis: RedisConnection) =>
            new RedisSignalStream(redis.client.duplicate()),
        },
      ],
    };
  }
}
