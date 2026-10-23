import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, type Provider, Module } from '@nestjs/common';
import { ExchangesModule } from '../exchanges/exchanges.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PortfolioModule } from '../portfolio/portfolio.module.js';
import { backgroundJobsEnabled } from '../queue/queue.module.js';
import { RiskModule } from '../risk/risk.module.js';
import { ExitMonitor } from './exit-monitor.js';
import { CcxtGateway } from './gateway/ccxt.gateway.js';
import { ExchangeGateway } from './gateway/exchange-gateway.js';
import { InlineOrderDispatcher, OrderDispatcher } from './order-dispatcher.js';
import { OrderExecutor } from './order-executor.js';
import { OrdersController } from './orders.controller.js';
import {
  BullOrderDispatcher,
  ORDER_EXITS_QUEUE,
  ORDERS_QUEUE,
  OrderExitsProcessor,
  OrderExitsScheduler,
  OrdersProcessor,
} from './orders.processor.js';
import { OrdersService } from './orders.service.js';

/**
 * Passage et exécution des ordres. L'API et les garde-fous sont toujours actifs ; la file BullMQ (retries avec
 * backoff) et la surveillance des stop-loss / take-profit ne le sont que si les jobs de fond sont actifs.
 * Avec `BACKGROUND_JOBS_ENABLED=false`, l'ordre est exécuté dans la requête, sans nouvel essai.
 */
@Module({})
export class OrdersModule {
  static register(): DynamicModule {
    const jobs = backgroundJobsEnabled();

    const providers: Provider[] = [
      OrdersService,
      OrderExecutor,
      ExitMonitor,
      { provide: ExchangeGateway, useClass: CcxtGateway },
      {
        provide: OrderDispatcher,
        useClass: jobs ? BullOrderDispatcher : InlineOrderDispatcher,
      },
      ...(jobs
        ? [OrdersProcessor, OrderExitsProcessor, OrderExitsScheduler]
        : []),
    ];

    return {
      module: OrdersModule,
      imports: [
        ExchangesModule,
        PortfolioModule,
        RiskModule,
        NotificationsModule,
        ...(jobs
          ? [
              BullModule.registerQueue({ name: ORDERS_QUEUE }),
              BullModule.registerQueue({
                name: ORDER_EXITS_QUEUE,
                defaultJobOptions: {
                  removeOnComplete: { count: 20 },
                  removeOnFail: { count: 100 },
                },
              }),
            ]
          : []),
      ],
      controllers: [OrdersController],
      providers,
      exports: [OrdersService],
    };
  }
}
