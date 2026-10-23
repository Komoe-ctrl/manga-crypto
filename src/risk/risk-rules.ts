import { Prisma } from '../generated/prisma/client.js';

export type DecimalInput = Prisma.Decimal | string | number;
export type Side = 'BUY' | 'SELL';

const HUNDRED = new Prisma.Decimal(100);
const pct = (value: DecimalInput) => new Prisma.Decimal(value).div(HUNDRED);

/**
 * Règles de gestion des risques (SPEC module 2), en `Decimal` et sans effet de bord : le module d'ordres
 * les appelle avec les données du portefeuille. Les résultats ne sont pas arrondis : l'arrondi dépend
 * de la précision de la plateforme et revient à l'appelant.
 */

/** Valeur maximale engageable sur une position : `maxExposurePct` % du capital total. */
export function maxPositionValue(
  totalCapital: DecimalInput,
  maxExposurePct: DecimalInput,
): Prisma.Decimal {
  return new Prisma.Decimal(totalCapital).mul(pct(maxExposurePct));
}

/** Vrai si la position dépasse l'exposition maximale (égalité autorisée). Un capital nul ou négatif interdit toute position. */
export function exceedsExposure(
  positionValue: DecimalInput,
  totalCapital: DecimalInput,
  maxExposurePct: DecimalInput,
): boolean {
  if (new Prisma.Decimal(totalCapital).lte(0)) return true;
  return new Prisma.Decimal(positionValue).gt(
    maxPositionValue(totalCapital, maxExposurePct),
  );
}

/**
 * Prix de stop-loss et de take-profit d'une entrée. Achat : stop sous le prix, objectif au-dessus.
 * Vente (à découvert) : inversé.
 */
export function stopLossTakeProfit(
  side: Side,
  entryPrice: DecimalInput,
  stopLossPct: DecimalInput,
  takeProfitPct: DecimalInput,
): { stopLoss: Prisma.Decimal; takeProfit: Prisma.Decimal } {
  const entry = new Prisma.Decimal(entryPrice);
  const down = new Prisma.Decimal(1).minus(pct(stopLossPct));
  const up = new Prisma.Decimal(1).plus(pct(takeProfitPct));
  return side === 'BUY'
    ? { stopLoss: entry.mul(down), takeProfit: entry.mul(up) }
    : {
        stopLoss: entry.mul(new Prisma.Decimal(1).plus(pct(stopLossPct))),
        takeProfit: entry.mul(new Prisma.Decimal(1).minus(pct(takeProfitPct))),
      };
}

/**
 * Vrai si la perte de la journée atteint ou dépasse `maxDailyLossPct` % de la valeur d'ouverture :
 * le robot doit alors se mettre en pause et prévenir le client (alerte critique).
 * Sans valeur d'ouverture positive, aucune perte ne peut être calculée : faux.
 */
export function dailyLossBreached(
  startOfDayEquity: DecimalInput,
  currentEquity: DecimalInput,
  maxDailyLossPct: DecimalInput,
): boolean {
  const start = new Prisma.Decimal(startOfDayEquity);
  if (start.lte(0)) return false;
  const lossPct = start.minus(currentEquity).div(start).mul(HUNDRED);
  return lossPct.gte(maxDailyLossPct);
}
