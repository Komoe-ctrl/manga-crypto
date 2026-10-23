import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { OrderDispatcher } from './order-dispatcher.js';
import { OrderExecutor } from './order-executor.js';
import { ExitMonitor, type ExitRunSummary } from './exit-monitor.js';

export const ORDERS_QUEUE = 'orders';
export const ORDER_EXITS_QUEUE = 'order-exits';
const EXITS_SCHEDULER_ID = 'order-exits-check';
/** Fréquence de la surveillance des stop-loss et take-profit : un seuil est détecté à une minute près. */
export const EXITS_CHECK_INTERVAL_MS = 60_000;

/** Essais d'un ordre : 5, avec un délai qui double (2 s, 4 s, 8 s, 16 s). L'identifiant d'ordre reste le même. */
export const ORDER_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
} as const;

export interface OrderJobData {
  tradeLogId: string;
}

/** Met un ordre en file. L'`jobId` est l'identifiant de l'ordre : le même ordre ne peut pas être mis en file deux fois. */
@Injectable()
export class BullOrderDispatcher extends OrderDispatcher {
  constructor(
    @InjectQueue(ORDERS_QUEUE) private readonly queue: Queue<OrderJobData>,
  ) {
    super();
  }

  async dispatch(tradeLogId: string): Promise<void> {
    await this.queue.add(
      'execute',
      { tradeLogId },
      { ...ORDER_JOB_OPTIONS, jobId: tradeLogId },
    );
  }
}

/**
 * Exécute les ordres, un à la fois (`concurrency: 1`, donc jamais deux ordres du même utilisateur en parallèle).
 * Une erreur transitoire fait réessayer l'ordre ; le dernier essai épuisé appelle `giveUp`.
 */
@Processor(ORDERS_QUEUE, { concurrency: 1 })
export class OrdersProcessor extends WorkerHost {
  constructor(private readonly executor: OrderExecutor) {
    super();
  }

  async process(job: Job<OrderJobData>): Promise<void> {
    await this.executor.execute(job.data.tradeLogId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<OrderJobData> | undefined): Promise<void> {
    // `failed` est émis à chaque échec : on n'abandonne l'ordre qu'au dernier essai.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await this.executor.giveUp(job.data.tradeLogId);
    }
  }
}

/** Surveille les stop-loss et take-profit des positions ouvertes. Une seule exécution à la fois. */
@Processor(ORDER_EXITS_QUEUE, { concurrency: 1 })
export class OrderExitsProcessor extends WorkerHost {
  constructor(private readonly monitor: ExitMonitor) {
    super();
  }

  process(): Promise<ExitRunSummary> {
    return this.monitor.run();
  }
}

/** Programme le job répétable au démarrage (idempotent : redémarrer l'application ne crée pas de doublon). */
@Injectable()
export class OrderExitsScheduler implements OnModuleInit {
  constructor(@InjectQueue(ORDER_EXITS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EXITS_SCHEDULER_ID,
      { every: EXITS_CHECK_INTERVAL_MS },
      { name: 'check' },
    );
  }
}
