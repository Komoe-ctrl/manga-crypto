import { Injectable, Logger } from '@nestjs/common';
import type { NotificationStatus } from '../generated/prisma/enums.js';
import type { OrderView } from '../orders/orders.types.js';

/** État du robot poussé au front (sous-ensemble de `TradingStatusDto`). */
export interface RiskEventData {
  tradingMode: string;
  killSwitchActive: boolean;
  botPausedUntil: Date | null;
  canTrade: boolean;
  blockedReason: 'KILL_SWITCH' | 'PAUSED_DAILY_LOSS' | null;
}

/** Notification poussée au front : pas de détail de livraison, seulement de quoi alimenter la boîte de réception. */
export interface NotificationEventData {
  id: string;
  title: string;
  body: string;
  critical: boolean;
  status: NotificationStatus;
  createdAt: Date;
}

/**
 * Événements envoyés au front (SPEC section 8). `type` devient le champ `event` du message WebSocket ; les montants
 * restent des chaînes décimales (ce sont des `OrderView`).
 */
export type RealtimeEvent =
  | { type: 'order'; data: OrderView }
  | { type: 'risk'; data: RiskEventData }
  | { type: 'notification'; data: NotificationEventData };

export type RealtimeListener = (userId: string, event: RealtimeEvent) => void;

/**
 * Bus interne, en mémoire : les services métier y publient, la passerelle WebSocket s'y abonne. Les modules métier ne
 * connaissent donc pas le WebSocket, et `publish` ne lève jamais d'erreur : une panne de diffusion ne doit pas faire
 * échouer un ordre, une notification ou un changement de mode.
 */
@Injectable()
export class RealtimeBus {
  private readonly logger = new Logger(RealtimeBus.name);
  private readonly listeners = new Set<RealtimeListener>();

  /** @returns la fonction de désabonnement. */
  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(userId: string, event: RealtimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(userId, event);
      } catch (error) {
        this.logger.warn(
          `Diffusion temps réel échouée (${event.type}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
      }
    }
  }
}

/** Extrait de l'état du robot ce qui est envoyé au front. */
export function toRiskEvent(status: RiskEventData): RiskEventData {
  return {
    tradingMode: status.tradingMode,
    killSwitchActive: status.killSwitchActive,
    botPausedUntil: status.botPausedUntil,
    canTrade: status.canTrade,
    blockedReason: status.blockedReason,
  };
}
