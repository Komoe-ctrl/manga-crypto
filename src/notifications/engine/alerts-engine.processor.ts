import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AlertEvaluator, type EvaluationSummary } from './alert-evaluator.js';

export const ALERTS_ENGINE_QUEUE = 'alerts-engine';
const SCHEDULER_ID = 'alerts-evaluation';
/** Fréquence d'évaluation : un franchissement de seuil est détecté à une minute près. */
export const EVALUATION_INTERVAL_MS = 60_000;

/** Évalue toutes les alertes actives. Une seule exécution à la fois. */
@Processor(ALERTS_ENGINE_QUEUE, { concurrency: 1 })
export class AlertsEngineProcessor extends WorkerHost {
  constructor(private readonly evaluator: AlertEvaluator) {
    super();
  }

  process(): Promise<EvaluationSummary> {
    return this.evaluator.run();
  }
}

/** Programme le job répétable au démarrage (idempotent : redémarrer l'application ne crée pas de doublon). */
@Injectable()
export class AlertsEngineScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(ALERTS_ENGINE_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: EVALUATION_INTERVAL_MS },
      { name: 'evaluate' },
    );
  }
}
