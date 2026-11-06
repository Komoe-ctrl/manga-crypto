import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import { CoinMarketCapSource } from './coinmarketcap.source.js';

const quote = (price: number, rank: number | null, name = 'Bitcoin') => ({
  name,
  symbol: 'BTC',
  cmc_rank: rank,
  quote: {
    USD: { price, market_cap: price * 19_000_000, percent_change_24h: -0.5 },
  },
});

const reply = (body: unknown, status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );

describe('CoinMarketCapSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('envoie la clé dans un en-tête, jamais dans l’URL, et ignore les symboles invalides', async () => {
    const spy = reply({ data: { BTC: [quote(67000, 1)] } });
    const coins = await new CoinMarketCapSource('secret-key').coins(['BTC']);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('skip_invalid=true');
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['X-CMC_PRO_API_KEY']).toBe(
      'secret-key',
    );
    expect(coins.get('BTC')?.priceUsd.toString()).toBe('67000');
    expect(coins.get('BTC')?.rank).toBe(1);
  });

  it('garde, parmi des homonymes, celui de meilleur rang', async () => {
    reply({
      data: {
        BTC: [quote(0.01, 8000, 'Imposteur'), quote(67000, 1), quote(5, null)],
      },
    });
    const coins = await new CoinMarketCapSource('k').coins(['BTC']);
    expect(coins.get('BTC')?.name).toBe('Bitcoin');
  });

  it('omet un symbole absent de la réponse', async () => {
    reply({ data: { BTC: [quote(67000, 1)] } });
    const coins = await new CoinMarketCapSource('k').coins(['BTC', 'ZZZZ']);
    expect([...coins.keys()]).toEqual(['BTC']);
  });

  it.each([429, 401, 403, 500])(
    'traite le statut %i comme une indisponibilité',
    async (status) => {
      reply({ status: { error_code: 1 } }, status);
      await expect(new CoinMarketCapSource('k').coins(['BTC'])).rejects.toThrow(
        PriceUnavailableError,
      );
    },
  );

  it('ne propose pas d’historique', async () => {
    const source = new CoinMarketCapSource('k');
    await expect(source.hourlyCloses('BTC', 24)).rejects.toThrow(
      PriceUnavailableError,
    );
    await expect(source.priceAt('BTC', new Date())).rejects.toThrow(
      PriceUnavailableError,
    );
  });
});
