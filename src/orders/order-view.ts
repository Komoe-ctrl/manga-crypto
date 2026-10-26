import { Prisma, type TradeLog } from '../generated/prisma/client.js';
import type { OrderView } from './orders.types.js';

const D = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value);

const str = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : D(value).toFixed();

/** Vue d'un ordre pour l'API et le temps réel : montants en chaînes décimales. Fichier à part : l'exécuteur et le service s'en servent, et ils ne doivent pas s'importer l'un l'autre (cycle). */
export function toView(row: TradeLog): OrderView {
  return {
    id: row.id,
    clientOrderId: row.clientOrderId,
    mode: row.mode,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    status: row.status,
    origin: row.origin,
    quantity: D(row.quantity).toFixed(),
    filledQuantity: D(row.filledQuantity).toFixed(),
    avgFillPrice: str(row.avgFillPrice),
    fee: str(row.fee),
    feeCurrency: row.feeCurrency,
    stopLossPrice: str(row.stopLossPrice),
    takeProfitPrice: str(row.takeProfitPrice),
    failureReason: row.failureReason,
    parentOrderId: row.parentOrderId,
    createdAt: row.createdAt,
    executedAt: row.executedAt,
  };
}
