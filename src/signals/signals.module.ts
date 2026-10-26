import { type DynamicModule, Logger, Module } from '@nestjs/common';
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
 * La consommation des signaux est **désactivée par défaut** : il faut `SIGNALS_ENABLED=true` pour l'activer. Le
 * backtest du moteur (étapes 14 et 16 de crypto-engine) n'a démontré aucun avantage de sa stratégie : rien ne doit
 * passer d'ordre à partir de ses signaux sans un choix explicite (voir D114).
 */
export const signalsEnabled = (): boolean =>
  process.env.SIGNALS_ENABLED === 'true';

/**
 * Consommation des signaux du moteur (Redis Stream `signals`). Désactivée par défaut (`SIGNALS_ENABLED`) et avec
 * `BACKGROUND_JOBS_ENABLED=false` : aucune connexion Redis n'est alors ouverte.
 */
@Module({})
export class SignalsModule {
  static register(): DynamicModule {
    if (!backgroundJobsEnabled()) return { module: SignalsModule };
    if (!signalsEnabled()) {
      new Logger(SignalsModule.name).log(
        "Consommation des signaux désactivée (SIGNALS_ENABLED=true pour l'activer).",
      );
      return { module: SignalsModule };
    }

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
