import { Injectable } from '@nestjs/common';
import { OrderExecutor } from './order-executor.js';
import { RetryableOrderError } from './orders.types.js';

/**
 * Envoie un ordre enregistré (`PENDING`) à l'exécution. Classe abstraite servant de jeton d'injection : la file
 * BullMQ (retries avec backoff) en production, l'exécution immédiate quand les jobs de fond sont désactivés.
 */
export abstract class OrderDispatcher {
  abstract dispatch(tradeLogId: string): Promise<void>;
}

/**
 * Exécute l'ordre dans la requête, sans file ni nouvel essai (`BACKGROUND_JOBS_ENABLED=false` : tests, instance
 * sans jobs). Une erreur transitoire n'a pas de « tour suivant » : l'ordre est abandonné proprement.
 */
@Injectable()
export class InlineOrderDispatcher extends OrderDispatcher {
  constructor(private readonly executor: OrderExecutor) {
    super();
  }

  async dispatch(tradeLogId: string): Promise<void> {
    try {
      await this.executor.execute(tradeLogId);
    } catch (error) {
      if (!(error instanceof RetryableOrderError)) throw error;
      await this.executor.giveUp(tradeLogId);
    }
  }
}
