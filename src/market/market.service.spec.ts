import { Prisma } from '../generated/prisma/client.js';
import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import { MarketService } from './market.service.js';
import type { MarketCoin, MarketSource } from './market-source.js';
import { SymbolListPipe } from './symbol-list.pipe.js';

const coin = (symbol: string): MarketCoin => ({
  symbol,
  name: symbol,
  priceUsd: new Prisma.Decimal('1'),
  marketCapUsd: null,
  rank: null,
  change24hPct: null,
});

const source = (
  name: MarketSource['name'],
  known: string[] | Error,
): MarketSource =>
  ({
    name,
    coins: vi.fn(async (symbols: string[]) => {
      if (known instanceof Error) throw known;
      return new Map(
        symbols.filter((s) => known.includes(s)).map((s) => [s, coin(s)]),
      );
    }),
  }) as unknown as MarketSource;

describe('MarketService', () => {
  it('complète avec la source suivante ce que la première ne connaît pas, dans l’ordre demandé', async () => {
    const second = source('coinmarketcap', ['ETH']);
    const service = new MarketService([source('coingecko', ['BTC']), second]);
    const overview = await service.overview(['ETH', 'BTC']);
    expect(overview.coins.map((c) => [c.symbol, c.source])).toEqual([
      ['ETH', 'coinmarketcap'],
      ['BTC', 'coingecko'],
    ]);
    expect(second.coins).toHaveBeenCalledWith(['ETH']);
    expect(overview).toMatchObject({ unknown: [], complete: true });
  });

  it('liste les symboles inconnus de toutes les sources', async () => {
    const service = new MarketService([source('coingecko', ['BTC'])]);
    await expect(service.overview(['BTC', 'ZZZZ'])).resolves.toMatchObject({
      unknown: ['ZZZZ'],
      complete: true,
    });
  });

  it('saute une source en panne et signale une réponse incomplète', async () => {
    const service = new MarketService([
      source('coingecko', new PriceUnavailableError()),
      source('coinmarketcap', ['BTC']),
    ]);
    await expect(service.overview(['BTC', 'ETH'])).resolves.toMatchObject({
      unknown: ['ETH'],
      complete: false,
    });
  });

  it('lève PriceUnavailableError quand aucune source ne répond', async () => {
    const service = new MarketService([
      source('coingecko', new PriceUnavailableError()),
    ]);
    await expect(service.overview(['BTC'])).rejects.toThrow(
      PriceUnavailableError,
    );
  });
});

describe('SymbolListPipe', () => {
  const pipe = new SymbolListPipe();

  it('normalise, retire les doublons et les blancs', () => {
    expect(pipe.transform(' btc, ETH ,btc,')).toEqual(['BTC', 'ETH']);
  });

  it.each([undefined, '', ' , ', 'BTC,é', 'A', 'X'.repeat(13), 'a b'])(
    'refuse %j',
    (value) => {
      expect(() => pipe.transform(value)).toThrow();
    },
  );

  it('refuse plus de 25 symboles', () => {
    const many = Array.from({ length: 26 }, (_, i) => `AB${i}`).join(',');
    expect(() => pipe.transform(many)).toThrow();
  });
});
