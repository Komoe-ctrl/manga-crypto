import { Prisma } from '../generated/prisma/client.js';
import {
  SPARKLINE_POINTS,
  WEEK_HOURS,
  changePct,
  computeTrend,
  downsample,
  marketState,
} from './trends-math.js';

const D = (v: string | number) => new Prisma.Decimal(v);
/** Série de `n` clôtures de `start` à `end`, linéaire. */
const ramp = (n: number, start: number, end: number) =>
  Array.from({ length: n }, (_, i) =>
    D(start + ((end - start) * i) / Math.max(n - 1, 1)),
  );

describe('changePct', () => {
  it('calcule la variation en %, arrondie à 2 décimales, sans nombre à virgule', () => {
    expect(changePct(D(100), D(105))?.toFixed()).toBe('5');
    expect(changePct(D(200), D(150))?.toFixed()).toBe('-25');
    expect(changePct(D(3), D(4))?.toFixed()).toBe('33.33');
    // une variation minuscule s'arrondit à 0, sans artefact de flottant
    expect(changePct(D('0.3'), D('0.30000001'))?.toFixed()).toBe('0');
  });

  it('refuse de diviser par zéro', () => {
    expect(changePct(D(0), D(10))).toBeNull();
  });
});

describe('downsample', () => {
  it('garde la série telle quelle si elle est assez courte', () => {
    expect(downsample([1, 2, 3], 42)).toEqual([1, 2, 3]);
  });

  it('réduit à `max` points en gardant le premier ET le dernier', () => {
    const series = Array.from({ length: 168 }, (_, i) => i);
    const out = downsample(series, 42);
    expect(out).toHaveLength(42);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(167); // la courbe finit sur le prix du moment
    expect([...out].sort((a, b) => a - b)).toEqual(out); // l'ordre est conservé
    expect(new Set(out).size).toBe(42); // pas de doublon
  });
});

describe('computeTrend', () => {
  it('semaine complète : variations 24 h et 7 jours, courbe de 42 points', () => {
    const closes = ramp(WEEK_HOURS, 100, 168);
    const trend = computeTrend(closes);

    // 24 h avant la dernière clôture : indice 167 − 24 = 143
    const dayAgo = closes[143];
    expect(trend.change24hPct?.toFixed()).toBe(
      changePct(dayAgo, closes[167])?.toFixed(),
    );
    expect(trend.change7dPct?.toFixed()).toBe('68'); // de 100 à 168
    expect(trend.sparkline).toHaveLength(SPARKLINE_POINTS);
    expect(trend.sparkline.at(-1)?.toFixed()).toBe('168');
  });

  it('un actif récent (moins de 7 jours) : pas de variation 7 jours, mais celle de 24 h oui', () => {
    const trend = computeTrend(ramp(60, 100, 120));
    expect(trend.change7dPct).toBeNull();
    expect(trend.change24hPct).not.toBeNull();
    expect(trend.sparkline.length).toBeGreaterThan(1);
  });

  it('moins de 25 clôtures : ni 24 h ni 7 jours, la courbe reste', () => {
    const trend = computeTrend(ramp(10, 100, 110));
    expect(trend.change24hPct).toBeNull();
    expect(trend.change7dPct).toBeNull();
    expect(trend.sparkline).toHaveLength(10);
  });

  it('exactement 25 clôtures : la variation 24 h existe', () => {
    expect(computeTrend(ramp(25, 100, 110)).change24hPct?.toFixed()).toBe('10');
  });

  it('une baisse est négative', () => {
    expect(
      computeTrend(ramp(WEEK_HOURS, 200, 100)).change7dPct?.toFixed(),
    ).toBe('-50');
  });

  it('série vide : tout est vide, sans erreur', () => {
    expect(computeTrend([])).toEqual({
      change24hPct: null,
      change7dPct: null,
      sparkline: [],
    });
  });
});

describe('marketState', () => {
  it.each([
    ['2', 'UP'],
    ['5.4', 'UP'],
    ['1.99', 'CALM'],
    ['0', 'CALM'],
    ['-1.99', 'CALM'],
    ['-2', 'DOWN'],
    ['-8', 'DOWN'],
  ])('BTC %s %% sur 24 h → %s', (pct, state) => {
    expect(marketState(D(pct))).toBe(state);
  });

  it('sans donnée du BTC : inconnu, on ne devine pas', () => {
    expect(marketState(null)).toBeNull();
  });
});
