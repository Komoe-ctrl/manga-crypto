import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DailyLossMonitor } from './daily-loss.monitor.js';

export const RISK_MONITOR_QUEUE = 'risk-monitor';
const SCHEDULER_ID = 'daily-loss-check';
/** Fréquence de la surveillance : la valeur d'ouverture est prise au plus 5 minutes après minuit local. */
export const CHECK_INTERVAL_MS = 5 * 60_000;

export interface MonitorRunResult {
  checked: number;
  paused: number;
  failed: number;
}

/** Exécute la surveillance de la perte journalière pour tous les utilisateurs actifs. Une seule exécution à la fois. */
@Processor(RISK_MONITOR_QUEUE, { concurrency: 1 })
export class RiskMonitorProcessor extends WorkerHost {
  private readonly logger = new Logger(RiskMonitorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly monitor: DailyLossMonitor,
  ) {
    super();
  }

  async process(): Promise<MonitorRunResult> {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    const result: MonitorRunResult = { checked: 0, paused: 0, failed: 0 };

    for (const { id } of users) {
      // Une erreur chez un utilisateur ne doit pas empêcher la surveillance des autres.
      try {
        if ((await this.monitor.checkUser(id)) === 'paused') result.paused++;
        result.checked++;
      } catch (error) {
        result.failed++;
        // Nom de l'erreur seulement : un message d'erreur peut embarquer des données.
        this.logger.error(
          `Surveillance en échec (userId=${id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
      }
    }
    return result;
  }
}

/** Programme le job répétable au démarrage (idempotent : redémarrer l'application ne crée pas de doublon). */
@Injectable()
export class RiskMonitorScheduler implements OnModuleInit {
  constructor(@InjectQueue(RISK_MONITOR_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: CHECK_INTERVAL_MS },
      { name: 'check' },
    );
  }
}
