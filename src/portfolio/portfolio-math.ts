import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const D = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value);

/** Le prix moyen est stocké avec 8 décimales (Decimal(38,8)). */
const PRICE_DECIMALS = 8;

export interface Position {
  quantity: Decimal;
  avgBuyPrice: Decimal;
}

/** Vente supérieure à la quantité détenue. */
export class InsufficientQuantityError extends Error {
  constructor() {
    super('Quantité insuffisante');
    this.name = 'InsufficientQuantityError';
  }
}

/** Achat : quantité cumulée et prix moyen pondéré. Sans position existante, le prix moyen est le prix d'achat. */
export function applyBuy(
  current: Position | null,
  quantity: Decimal,
  price: Decimal,
): Position {
  if (!current)
    return { quantity, avgBuyPrice: price.toDecimalPlaces(PRICE_DECIMALS) };
  const total = current.quantity.plus(quantity);
  const avg = current.quantity
    .mul(current.avgBuyPrice)
    .plus(quantity.mul(price))
    .div(total);
  return { quantity: total, avgBuyPrice: avg.toDecimalPlaces(PRICE_DECIMALS) };
}

/**
 * Vente : le prix moyen ne change pas. Renvoie la position restante (`null` si soldée) et le gain réalisé.
 * @throws InsufficientQuantityError si `quantity` dépasse la quantité détenue.
 */
export function applySell(
  current: Position | null,
  quantity: Decimal,
  price: Decimal,
): { position: Position | null; realizedPnl: Decimal } {
  if (!current || quantity.gt(current.quantity))
    throw new InsufficientQuantityError();
  const remaining = current.quantity.minus(quantity);
  return {
    position: remaining.isZero()
      ? null
      : { quantity: remaining, avgBuyPrice: current.avgBuyPrice },
    realizedPnl: price.minus(current.avgBuyPrice).mul(quantity),
  };
}

export interface ValuedAsset {
  symbol: string;
  quantity: Decimal;
  avgBuyPrice: Decimal;
  /** Null quand aucun prix n'est disponible. */
  price: Decimal | null;
}

export interface AssetValuation {
  symbol: string;
  quantity: Decimal;
  avgBuyPrice: Decimal;
  currentPrice: Decimal | null;
  costBasis: Decimal;
  value: Decimal | null;
  pnl: Decimal | null;
  /** En %, sur le prix de revient ; null si le prix de revient est nul. */
  pnlPct: Decimal | null;
  /** Part de la valeur totale, en %. */
  weightPct: Decimal | null;
}

export interface PortfolioValuation {
  assets: AssetValuation[];
  /** Totaux sur les positions valorisées uniquement. */
  totalValue: Decimal;
  totalCost: Decimal;
  totalPnl: Decimal;
  totalPnlPct: Decimal | null;
  /** Faux si au moins une position n'a pas pu être valorisée. */
  complete: boolean;
}

const pctOf = (part: Decimal, whole: Decimal): Decimal | null =>
  whole.isZero() ? null : part.div(whole).mul(100).toDecimalPlaces(2);

/**
 * Valorise un portefeuille. Les positions sans prix restent listées (valeur `null`) mais sont exclues
 * des totaux, des poids et du P&L : un total partiel n'a de sens que si on sait qu'il l'est (`complete`).
 */
export function valuePortfolio(assets: ValuedAsset[]): PortfolioValuation {
  const priced = assets.filter((a) => a.price !== null);
  const totalValue = priced.reduce(
    (sum, a) => sum.plus(a.quantity.mul(a.price!)),
    D(0),
  );
  const totalCost = priced.reduce(
    (sum, a) => sum.plus(a.quantity.mul(a.avgBuyPrice)),
    D(0),
  );
  const totalPnl = totalValue.minus(totalCost);

  return {
    assets: assets.map((a) => {
      const costBasis = a.quantity.mul(a.avgBuyPrice);
      if (a.price === null) {
        return {
          ...base(a),
          currentPrice: null,
          costBasis,
          value: null,
          pnl: null,
          pnlPct: null,
          weightPct: null,
        };
      }
      const value = a.quantity.mul(a.price);
      const pnl = value.minus(costBasis);
      return {
        ...base(a),
        currentPrice: a.price,
        costBasis,
        value,
        pnl,
        pnlPct: pctOf(pnl, costBasis),
        weightPct: pctOf(value, totalValue),
      };
    }),
    totalValue,
    totalCost,
    totalPnl,
    totalPnlPct: pctOf(totalPnl, totalCost),
    complete: priced.length === assets.length,
  };
}

const base = (a: ValuedAsset) => ({
  symbol: a.symbol,
  quantity: a.quantity,
  avgBuyPrice: a.avgBuyPrice,
});
