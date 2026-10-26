import { Prisma } from '../generated/prisma/client.js';
import { maxPositionValue, type DecimalInput } from '../risk/risk-rules.js';

export type SizingSkip = 'below_min_score' | 'no_capacity' | 'too_small';

export type Sizing = { quantity: Prisma.Decimal } | { skip: SizingSkip };

/** Une quantité est arrondie **à la baisse** à 8 décimales : l'arrondi ne doit jamais faire dépasser l'exposition. */
const QUANTITY_DECIMALS = 8;

export interface BuySizingInput {
  /** Confiance du signal, de 0 à 1. */
  score: number;
  /** Score minimal pour agir (0,6 par défaut). */
  minScore: number;
  /** Prix courant de l'actif, en USD. */
  price: DecimalInput;
  /** Capital total du portefeuille, en USD. */
  capital: DecimalInput;
  /** Exposition maximale par position, en % du capital. */
  maxExposurePct: DecimalInput;
  /** Quantité déjà détenue de cet actif. */
  heldQuantity: DecimalInput;
}

/**
 * Dimensionne un achat décidé par un signal : on achète jusqu'à l'exposition maximale par position, moins ce qui
 * est déjà détenu (« place disponible »), **proportionnellement au score** (score 0,8 = 80 % de la place).
 * Fonction pure en `Decimal`. Un signal sous `minScore`, une position déjà au plafond ou une quantité arrondie à
 * zéro ne donnent aucun ordre.
 */
export function sizeBuy(input: BuySizingInput): Sizing {
  if (input.score < input.minScore) return { skip: 'below_min_score' };

  const price = new Prisma.Decimal(input.price);
  const cap = maxPositionValue(input.capital, input.maxExposurePct);
  const room = cap.minus(new Prisma.Decimal(input.heldQuantity).mul(price));
  if (room.lte(0)) return { skip: 'no_capacity' };

  const quantity = room
    .mul(input.score)
    .div(price)
    .toDecimalPlaces(QUANTITY_DECIMALS, Prisma.Decimal.ROUND_DOWN);
  return quantity.gt(0) ? { quantity } : { skip: 'too_small' };
}
