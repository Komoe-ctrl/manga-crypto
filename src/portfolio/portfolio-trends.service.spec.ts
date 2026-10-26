import { Prisma } from '../generated/prisma/client.js';
import { PortfolioTrendsService } from './portfolio-trends.service.js';
import type { PortfolioService } from './portfolio.service.js';
import {
  PriceUnavailableError,
  type PriceProvider,
} from './price/price-provider.js';

const D = (v: string | number) => new Prisma.Decimal(v);
const ramp = (n: number, start: number, end: number) =>
  Array.from({ length: n }, (_, i) => D(start + ((end - start) * i) / (n - 1)));

const holding = (symbol: string) => ({
  symbol,
  quantity: D(1),
  avgBuyPrice: D(1),
});

function build(
  symbols: string[],
  series: Record<string, Prisma.Decimal[] | null | Error>,
) {
  const portfolio = {
    list: vi.fn(async () => symbols.map(holding)),
  } as unknown as PortfolioService;
  const getHourlyCloses = vi.fn(async (symbol: string) => {
    const result = series[symbol] ?? null;
    if (result instanceof Error) throw result;
    return result;
  });
  const prices = {
    getPrices: vi.fn(),
    getPriceAt: vi.fn(),
    getHourlyCloses,
  } as unknown as PriceProvider;
  return {
    service: new PortfolioTrendsService(portfolio, prices),
    getHourlyCloses,
  };
}

describe('PortfolioTrendsService', () => {
  it('variations, courbes et état du marché, en chaînes décimales', async () => {
    const { service } = build(['BTC', 'ETH'], {
      BTC: ramp(168, 100, 110),
      ETH: ramp(168, 50, 25),
    });
    const result = await service.trends('u1');

    expect(result.complete).toBe(true);
    expect(result.assets.map((a) => a.symbol)).toEqual(['BTC', 'ETH']);
    expect(result.assets[0].change7dPct).toBe('10');
    expect(result.assets[1].change7dPct).toBe('-50');
    expect(result.assets[0].sparkline).toHaveLength(42);
    expect(typeof result.assets[0].sparkline[0]).toBe('string');
    expect(result.market.btcChange24hPct).toBe(result.assets[0].change24hPct);
    expect(result.market.state).toBe('CALM'); // BTC : +10 % sur 7 jours mais environ +1,4 % sur 24 h
  });

  it('un marché en forte hausse ou baisse sur 24 h', async () => {
    const up = build(['BTC'], {
      BTC: ramp(168, 100, 100).map((_, i) =>
        D(i < 144 ? 100 : 100 + (i - 143)),
      ),
    });
    expect((await up.service.trends('u1')).market.state).toBe('UP'); // 100 → 124 sur 24 h

    const down = build(['BTC'], {
      BTC: ramp(168, 100, 100).map((_, i) =>
        D(i < 144 ? 100 : 100 - (i - 143)),
      ),
    });
    expect((await down.service.trends('u1')).market.state).toBe('DOWN');
  });

  it('les stablecoins n’ont pas de courbe : ils ne sont pas dans la réponse ni demandés', async () => {
    const { service, getHourlyCloses } = build(['USDT', 'BTC'], {
      BTC: ramp(168, 100, 110),
    });
    const result = await service.trends('u1');

    expect(result.assets.map((a) => a.symbol)).toEqual(['BTC']);
    expect(getHourlyCloses.mock.calls.map((c) => c[0])).not.toContain('USDT');
  });

  it('le BTC est lu pour le marché même si l’utilisateur n’en détient pas, sans apparaître dans ses actifs', async () => {
    const { service, getHourlyCloses } = build(['ETH'], {
      ETH: ramp(168, 100, 105),
      BTC: ramp(168, 100, 90),
    });
    const result = await service.trends('u1');

    expect(result.assets.map((a) => a.symbol)).toEqual(['ETH']);
    expect(getHourlyCloses.mock.calls.map((c) => c[0]).sort()).toEqual([
      'BTC',
      'ETH',
    ]);
    expect(result.market.btcChange24hPct).not.toBeNull();
  });

  it('le BTC détenu n’est demandé qu’une fois', async () => {
    const { service, getHourlyCloses } = build(['BTC'], {
      BTC: ramp(168, 1, 2),
    });
    await service.trends('u1');
    expect(getHourlyCloses).toHaveBeenCalledTimes(1);
  });

  it('une source en panne pour un actif : cet actif est vide, la réponse est partielle, rien ne plante', async () => {
    const { service } = build(['BTC', 'ETH'], {
      BTC: ramp(168, 100, 110),
      ETH: new PriceUnavailableError(),
    });
    const result = await service.trends('u1');

    expect(result.complete).toBe(false);
    expect(result.assets[1]).toEqual({
      symbol: 'ETH',
      change24hPct: null,
      change7dPct: null,
      sparkline: [],
    });
    expect(result.assets[0].sparkline.length).toBeGreaterThan(0);
  });

  it('actif inconnu de la source : vide et partiel', async () => {
    const { service } = build(['ZZZ'], { ZZZ: null, BTC: ramp(168, 1, 2) });
    const result = await service.trends('u1');
    expect(result.complete).toBe(false);
    expect(result.assets[0].sparkline).toEqual([]);
  });

  it('le BTC injoignable : marché inconnu, pas inventé', async () => {
    const { service } = build(['ETH'], {
      ETH: ramp(168, 1, 2),
      BTC: new PriceUnavailableError(),
    });
    const result = await service.trends('u1');
    expect(result.market).toEqual({ state: null, btcChange24hPct: null });
    expect(result.complete).toBe(true); // ses propres actifs sont complets
  });

  it('portefeuille vide : aucun actif, mais l’état du marché reste donné', async () => {
    const { service } = build([], { BTC: ramp(168, 100, 100) });
    const result = await service.trends('u1');
    expect(result.assets).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.market.state).toBe('CALM');
  });

  it('une erreur qui n’est pas une panne de prix remonte (on ne masque pas un vrai bug)', async () => {
    const { service } = build(['BTC'], { BTC: new RangeError('bug') });
    await expect(service.trends('u1')).rejects.toBeInstanceOf(RangeError);
  });

  it('au-delà de 30 actifs : les suivants sont ignorés et la réponse est partielle', async () => {
    const symbols = Array.from({ length: 32 }, (_, i) => `A${i}`);
    const series = Object.fromEntries(symbols.map((s) => [s, ramp(168, 1, 2)]));
    const { service, getHourlyCloses } = build(symbols, {
      ...series,
      BTC: ramp(168, 1, 2),
    });
    const result = await service.trends('u1');

    expect(result.assets).toHaveLength(30);
    expect(result.complete).toBe(false);
    expect(getHourlyCloses).toHaveBeenCalledTimes(31); // 30 actifs + le BTC
  });
});
