import { Prisma } from '../../generated/prisma/client.js';
import type { DecimalInput } from '../risk-rules.js';

/** Position à l'ouverture de la journée, en chaînes décimales (stockée en JSON dans EquitySnapshot). */
export interface OpenHolding {
  symbol: string;
  quantity: string;
  price: string;
}

/**
 * Valeur actuelle des positions d'**ouverture** : chaque quantité d'ouverture au prix courant.
 * Les achats et ventes déclarés dans la journée n'y figurent pas : seule la variation de marché compte, un retrait
 * ou un virement ne peut donc pas déclencher une pause. Renvoie `null` si un prix manque : on ne conclut pas
 * sur un total partiel.
 */
export function openHoldingsValueNow(
  holdings: OpenHolding[],
  prices: Map<string, Prisma.Decimal | null>,
): Prisma.Decimal | null {
  let total = new Prisma.Decimal(0);
  for (const holding of holdings) {
    const price = prices.get(holding.symbol);
    if (!price) return null;
    total = total.plus(new Prisma.Decimal(holding.quantity).mul(price));
  }
  return total;
}

/** Perte en % de la valeur d'ouverture (négative en cas de gain). Valeur d'ouverture nulle : 0. */
export function lossPct(
  openEquity: Prisma.Decimal,
  currentValue: Prisma.Decimal,
): Prisma.Decimal {
  if (openEquity.lte(0)) return new Prisma.Decimal(0);
  return openEquity
    .minus(currentValue)
    .div(openEquity)
    .mul(100)
    .toDecimalPlaces(2);
}

/** Valeur d'ouverture et positions d'un portefeuille valorisé, au format de l'instantané. */
export function toSnapshot(
  holdings: { symbol: string; quantity: DecimalInput }[],
  prices: Map<string, Prisma.Decimal | null>,
): { equity: Prisma.Decimal; holdings: OpenHolding[] } | null {
  const open: OpenHolding[] = [];
  let equity = new Prisma.Decimal(0);
  for (const holding of holdings) {
    const price = prices.get(holding.symbol);
    if (!price) return null;
    const quantity = new Prisma.Decimal(holding.quantity);
    open.push({
      symbol: holding.symbol,
      quantity: quantity.toFixed(),
      price: price.toFixed(),
    });
    equity = equity.plus(quantity.mul(price));
  }
  return { equity, holdings: open };
}
