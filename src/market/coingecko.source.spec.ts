import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import { CoinGeckoSource } from './coingecko.source.js';

const reply = (body: unknown, status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );

const markets = [
  {
    id: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    current_price: 67250.12,
    market_cap: 1_330_000_000_000,
    market_cap_rank: 1,
    price_change_percentage_24h: -1.84,
  },
  // homonyme moins capitalisé : ne doit pas écraser le vrai
  {
    id: 'batcat',
    symbol: 'btc',
    name: 'BatCat',
    current_price: 0.0001,
    market_cap: 10,
    market_cap_rank: 9000,
    price_change_percentage_24h: 5,
  },
];

describe('CoinGeckoSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lit prix, capitalisation, rang et variation, et garde le premier homonyme', async () => {
    reply(markets);
    const coins = await new CoinGeckoSource().coins(['BTC']);
    const btc = coins.get('BTC')!;
    expect(btc.name).toBe('Bitcoin');
    expect(btc.priceUsd.toString()).toBe('67250.12');
    expect(btc.rank).toBe(1);
    expect(btc.change24hPct?.toString()).toBe('-1.84');
  });

  it('omet les symboles inconnus', async () => {
    reply(markets);
    const coins = await new CoinGeckoSource().coins(['BTC', 'ZZZZ']);
    expect([...coins.keys()]).toEqual(['BTC']);
  });

  it('met en cache : un second appel ne contacte pas CoinGecko', async () => {
    const spy = reply(markets);
    const source = new CoinGeckoSource();
    await source.coins(['BTC']);
    await source.coins(['BTC']);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("n'envoie la clé que dans l'en-tête de l'offre choisie", async () => {
    const spy = reply(markets);
    await new CoinGeckoSource({ apiKey: 'demo-key' }).coins(['BTC']);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.coingecko\.com\//);
    expect(url).not.toContain('demo-key');
    expect((init.headers as Record<string, string>)['x-cg-demo-api-key']).toBe(
      'demo-key',
    );

    spy.mockClear();
    await new CoinGeckoSource({ apiKey: 'pro-key', pro: true }).coins(['ETH']);
    const [proUrl, proInit] = spy.mock.calls[0] as [string, RequestInit];
    expect(proUrl).toMatch(/^https:\/\/pro-api\.coingecko\.com\//);
    expect(
      (proInit.headers as Record<string, string>)['x-cg-pro-api-key'],
    ).toBe('pro-key');
  });

  it.each([429, 401, 503])(
    'traite le statut %i comme une indisponibilité',
    async (status) => {
      reply({}, status);
      await expect(new CoinGeckoSource().coins(['BTC'])).rejects.toThrow(
        PriceUnavailableError,
      );
    },
  );

  it('traite une erreur réseau comme une indisponibilité', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fail'));
    await expect(new CoinGeckoSource().coins(['BTC'])).rejects.toThrow(
      PriceUnavailableError,
    );
  });

  describe('historique', () => {
    const chart = (points: [number, number][]) => ({ prices: points });

    function twoCalls(second: unknown) {
      return vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(markets)))
        .mockResolvedValueOnce(new Response(JSON.stringify(second)));
    }

    it('renvoie les dernières clôtures horaires, la plus récente en dernier', async () => {
      const spy = twoCalls(
        chart([
          [1, 10],
          [2, 11],
          [3, 12],
          [4, 13],
        ]),
      );
      const closes = await new CoinGeckoSource().hourlyCloses('BTC', 3);
      expect(closes?.map(String)).toEqual(['11', '12', '13']);
      expect(spy.mock.calls[1]![0]).toContain('/coins/bitcoin/market_chart');
      expect(spy.mock.calls[1]![0]).toContain('days=2');
    });

    it('renvoie null pour un actif inconnu', async () => {
      reply([]);
      await expect(
        new CoinGeckoSource().hourlyCloses('ZZZZ', 24),
      ).resolves.toBeNull();
    });

    it('donne le point le plus proche de la date demandée', async () => {
      const at = new Date('2026-11-01T12:00:00Z');
      twoCalls(
        chart([
          [at.getTime() - 40 * 60_000, 100],
          [at.getTime() + 10 * 60_000, 101],
        ]),
      );
      const price = await new CoinGeckoSource().priceAt('BTC', at);
      expect(price?.toString()).toBe('101');
    });

    it('renvoie null quand aucun point n’est à moins d’une heure', async () => {
      const at = new Date('2026-11-01T12:00:00Z');
      twoCalls(chart([[at.getTime() - 90 * 60_000, 100]]));
      await expect(
        new CoinGeckoSource().priceAt('BTC', at),
      ).resolves.toBeNull();
    });
  });
});
