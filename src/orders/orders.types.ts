import type { Prisma } from '../generated/prisma/client.js';
import type {
  OrderOrigin,
  OrderSide,
  OrderStatus,
  OrderType,
  TradingMode,
} from '../generated/prisma/enums.js';
import type { RejectionReason } from './order-rules.js';

/**
 * Ce que l'on veut faire. Point d'entrée unique de l'exécution : l'API manuelle, le futur consommateur de signaux
 * et la surveillance des stop-loss / take-profit construisent tous une intention, puis passent par les mêmes garde-fous.
 */
export interface OrderIntent {
  /** Actif de base (« BTC ») ; la paire est `<base>/USDT`. */
  symbol: string;
  side: OrderSide;
  /** Quantité d'actif de base, strictement positive. */
  quantity: Prisma.Decimal;
  origin: OrderOrigin;
  /** Sortie automatique : ordre d'entrée dont celui-ci est la sortie. */
  parentOrderId?: string;
  /** Signal d'origine (traçabilité signal → ordre). */
  signalStreamId?: string;
  signalPayload?: Prisma.InputJsonValue;
}

/** Vue d'un ordre pour l'API : montants en chaînes décimales, jamais en nombres JSON. */
export interface OrderView {
  id: string;
  clientOrderId: string;
  mode: TradingMode;
  /** Paire, par exemple « BTC/USDT ». */
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  origin: OrderOrigin;
  quantity: string;
  filledQuantity: string;
  avgFillPrice: string | null;
  fee: string | null;
  feeCurrency: string | null;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  /** Code stable (voir `REJECTION_MESSAGES`) quand l'ordre est refusé ou en échec. */
  failureReason: RejectionReason | string | null;
  parentOrderId: string | null;
  createdAt: Date;
  executedAt: Date | null;
}

/** Ce signal a déjà donné lieu à un ordre pour cet utilisateur (contrainte unique `userId` + `signalStreamId`). */
export class DuplicateOrderError extends Error {
  constructor() {
    super('Un ordre existe déjà pour ce signal');
    this.name = 'DuplicateOrderError';
  }
}

/** Erreur transitoire de l'exécution : l'ordre sera réessayé (file BullMQ) ou abandonné après le dernier essai. */
export class RetryableOrderError extends Error {
  constructor(
    readonly reason:
      | 'price_unavailable'
      | 'exchange_unavailable'
      | 'not_settled'
      | 'no_credentials',
  ) {
    super(`Exécution à réessayer : ${reason}`);
    this.name = 'RetryableOrderError';
  }
}
