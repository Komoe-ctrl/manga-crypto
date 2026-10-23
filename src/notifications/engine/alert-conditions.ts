import { Prisma } from '../../generated/prisma/client.js';
import { AlertCondition } from '../../generated/prisma/enums.js';
import type { DecimalInput } from '../../risk/risk-rules.js';

const D = (value: DecimalInput) => new Prisma.Decimal(value);

/**
 * Valeurs observées pour évaluer une alerte. Pour un prix : le prix courant et, pour une variation, le prix au
 * début de la fenêtre. Pour le portefeuille : sa valeur courante et sa valeur (mêmes quantités) au début de la fenêtre.
 */
export interface Observation {
  current: DecimalInput | null;
  past: DecimalInput | null;
}

/** Variation en % entre `past` et `current` (positive à la hausse). `null` sans valeur de départ positive. */
export function changePct(
  current: DecimalInput,
  past: DecimalInput,
): Prisma.Decimal | null {
  const start = D(past);
  if (start.lte(0)) return null;
  return D(current).minus(start).div(start).mul(100);
}

/**
 * La condition de l'alerte est-elle remplie ? Seuil atteint = remplie (égalité incluse).
 * @returns `true` / `false`, ou `null` quand une donnée manque : on ne conclut pas, l'état de l'alerte est laissé tel quel.
 */
export function conditionMet(
  condition: AlertCondition,
  threshold: DecimalInput,
  { current, past }: Observation,
): boolean | null {
  if (current === null) return null;
  const limit = D(threshold);

  switch (condition) {
    case AlertCondition.PRICE_CROSS_ABOVE:
      return D(current).gte(limit);
    case AlertCondition.PRICE_CROSS_BELOW:
      return D(current).lte(limit);

    case AlertCondition.PRICE_RISE_PCT: {
      const change = past === null ? null : changePct(current, past);
      return change === null ? null : change.gte(limit);
    }
    case AlertCondition.PRICE_DROP_PCT:
    case AlertCondition.PORTFOLIO_DROP_PCT: {
      const change = past === null ? null : changePct(current, past);
      return change === null ? null : change.negated().gte(limit);
    }
  }
}
