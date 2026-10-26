import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;

/** Une série horaire complète sur 7 jours : 168 clôtures. */
export const WEEK_HOURS = 168;
export const DAY_HOURS = 24;
/** Points conservés pour une courbe : assez pour la forme, assez peu pour la réponse. */
export const SPARKLINE_POINTS = 42;
/** Seuil de l'indicateur de marché, en % sur 24 h. */
export const MARKET_THRESHOLD_PCT = 2;

export type MarketState = 'UP' | 'DOWN' | 'CALM';

export interface AssetTrend {
  change24hPct: Decimal | null;
  change7dPct: Decimal | null;
  /** Du plus ancien au plus récent, au plus `SPARKLINE_POINTS` valeurs. */
  sparkline: Decimal[];
}

/** Variation en % de `from` à `to`, arrondie à 2 décimales ; `null` si `from` est nul. */
export function changePct(from: Decimal, to: Decimal): Decimal | null {
  if (from.isZero()) return null;
  return to.minus(from).div(from).mul(100).toDecimalPlaces(2);
}

/**
 * Garde `max` points répartis sur toute la série, premier et dernier compris (la courbe doit finir sur le prix du
 * moment). Une série déjà assez courte est renvoyée telle quelle.
 */
export function downsample<T>(series: T[], max = SPARKLINE_POINTS): T[] {
  if (series.length <= max || max < 2)
    return series.slice(0, Math.max(max, 0) || series.length);
  const last = series.length - 1;
  return Array.from(
    { length: max },
    (_, i) => series[Math.round((i * last) / (max - 1))],
  );
}

/**
 * Variations et courbe d'une série de clôtures horaires (la dernière est le prix du moment).
 * - 24 h : exige 25 clôtures (le prix d'il y a 24 h existe) ; sinon `null`.
 * - 7 jours : exige la semaine complète (168 clôtures) ; un actif coté depuis 3 jours n'a pas de « 7 jours ».
 */
export function computeTrend(closes: Decimal[]): AssetTrend {
  const now = closes.at(-1);
  if (!now) return { change24hPct: null, change7dPct: null, sparkline: [] };
  const dayAgo =
    closes.length > DAY_HOURS ? closes[closes.length - 1 - DAY_HOURS] : null;
  const weekAgo =
    closes.length >= WEEK_HOURS ? closes[closes.length - WEEK_HOURS] : null;
  return {
    change24hPct: dayAgo ? changePct(dayAgo, now) : null,
    change7dPct: weekAgo ? changePct(weekAgo, now) : null,
    sparkline: downsample(closes),
  };
}

/**
 * Indicateur de marché, **descriptif** : le BTC sur 24 h. Ce n'est pas un signal d'achat ni de vente (le backtest du
 * projet n'a démontré aucun avantage des indicateurs) ; il dit seulement si la journée est agitée.
 */
export function marketState(btc24hPct: Decimal | null): MarketState | null {
  if (!btc24hPct) return null;
  if (btc24hPct.gte(MARKET_THRESHOLD_PCT)) return 'UP';
  if (btc24hPct.lte(-MARKET_THRESHOLD_PCT)) return 'DOWN';
  return 'CALM';
}
