import { BinancePriceProvider } from './binance-price.provider.js';
import { PriceUnavailableError } from './price-provider.js';

const tickers = [
  { symbol: 'BTCUSDT', price: '70000.10' },
  { symbol: 'ETHUSDT', price: '3000.00' },
  { symbol: 'DEADUSDT', price: '0.00000000' },
  { symbol: 'BROKEN' },
];

const reply = (status = 200, body: unknown = tickers) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );

describe('BinancePriceProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renvoie le prix USDT de chaque symbole, null pour un symbole inconnu ou à prix nul', async () => {
    reply();
    const prices = await new BinancePriceProvider().getPrices([
      'BTC',
      'ETH',
      'XYZ',
      'DEAD',
    ]);
    expect(prices.get('BTC')?.toFixed()).toBe('70000.1');
    expect(prices.get('ETH')?.toFixed()).toBe('3000');
    expect(prices.get('XYZ')).toBeNull();
    expect(prices.get('DEAD')).toBeNull();
  });

  it('valorise les stablecoins à 1 sans appeler la plateforme', async () => {
    const spy = reply();
    const prices = await new BinancePriceProvider().getPrices(['USDT', 'USDC']);
    expect(prices.get('USDT')?.toFixed()).toBe('1');
    expect(prices.get('USDC')?.toFixed()).toBe('1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('met en cache : un second appel ne refait pas la requête', async () => {
    const spy = reply();
    const provider = new BinancePriceProvider();
    await provider.getPrices(['BTC']);
    await provider.getPrices(['ETH']);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('partage une seule requête entre appels simultanés', async () => {
    const spy = reply();
    const provider = new BinancePriceProvider();
    await Promise.all([
      provider.getPrices(['BTC']),
      provider.getPrices(['ETH']),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('signale une indisponibilité (HTTP, réseau, réponse inattendue) et réessaie ensuite', async () => {
    const provider = new BinancePriceProvider();

    reply(503, {});
    await expect(provider.getPrices(['BTC'])).rejects.toThrow(
      PriceUnavailableError,
    );

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );
    await expect(provider.getPrices(['BTC'])).rejects.toThrow(
      PriceUnavailableError,
    );

    reply(200, { not: 'a list' });
    await expect(provider.getPrices(['BTC'])).rejects.toThrow(
      PriceUnavailableError,
    );

    // Un échec n'est pas mis en cache.
    reply();
    await expect(provider.getPrices(['BTC'])).resolves.toBeInstanceOf(Map);
  });
});
