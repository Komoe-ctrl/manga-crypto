import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DigestGenerator, type DigestRunSummary } from './digest.generator.js';

export const DIGEST_QUEUE = 'digest';
const SCHEDULER_ID = 'digest-check';
/** Fréquence de la vérification : un rapport part au plus 5 minutes après l'heure choisie. */
export const DIGEST_CHECK_INTERVAL_MS = 5 * 60_000;

/** Génère les rapports du matin dus. Une seule exécution à la fois. */
@Processor(DIGEST_QUEUE, { concurrency: 1 })
export class DigestEngineProcessor extends WorkerHost {
  constructor(private readonly generator: DigestGenerator) {
    super();
  }

  process(): Promise<DigestRunSummary> {
    return this.generator.run();
  }
}

/** Programme le job répétable au démarrage (idempotent : redémarrer l'application ne crée pas de doublon). */
@Injectable()
export class DigestEngineScheduler implements OnModuleInit {
  constructor(@InjectQueue(DIGEST_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: DIGEST_CHECK_INTERVAL_MS },
      { name: 'check' },
    );
  }
}
