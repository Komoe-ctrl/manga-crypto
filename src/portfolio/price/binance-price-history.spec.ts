import { BinancePriceProvider } from './binance-price.provider.js';
import { PriceUnavailableError } from './price-provider.js';

const AT = new Date('2026-10-23T11:00:30Z');
const MINUTE = Date.parse('2026-10-23T11:00:00Z');

/** Bougie Binance : [ouverture (ms), open, high, low, close, …]. */
const candle = (openTime = MINUTE, open = '66316.5') => [
  [openTime, open, '0', '0', '0'],
];

const reply = (body: unknown, status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );

describe('BinancePriceProvider.getPriceAt', () => {
  afterEach(() => vi.restoreAllMocks());

  it("renvoie l'ouverture de la bougie d'une minute de la paire USDT", async () => {
    const spy = reply(candle());
    const price = await new BinancePriceProvider().getPriceAt('BTC', AT);

    expect(price?.toFixed()).toBe('66316.5');
    const url = new URL(spy.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      'https://api.binance.com/api/v3/klines',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BTCUSDT',
      interval: '1m',
      startTime: String(MINUTE), // arrondi à la minute
      limit: '1',
    });
  });

  it('valorise les stablecoins à 1 sans appeler la plateforme', async () => {
    const spy = reply(candle());
    expect(
      (await new BinancePriceProvider().getPriceAt('USDT', AT))?.toFixed(),
    ).toBe('1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('met en cache par symbole et par minute', async () => {
    const spy = reply(candle());
    const provider = new BinancePriceProvider();
    await provider.getPriceAt('BTC', AT);
    await provider.getPriceAt('BTC', new Date(AT.getTime() + 20_000)); // même minute
    expect(spy).toHaveBeenCalledTimes(1);

    await provider.getPriceAt('BTC', new Date(AT.getTime() + 60_000)); // minute suivante
    await provider.getPriceAt('ETH', AT); // autre symbole
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('met aussi en cache l’absence de donnée', async () => {
    const spy = reply({ code: -1121, msg: 'Invalid symbol.' }, 400);
    const provider = new BinancePriceProvider();
    expect(await provider.getPriceAt('XYZ', AT)).toBeNull();
    expect(await provider.getPriceAt('XYZ', AT)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('renvoie null pour une paire inconnue, une réponse vide ou une bougie malformée', async () => {
    reply({ code: -1121, msg: 'Invalid symbol.' }, 400);
    expect(await new BinancePriceProvider().getPriceAt('XYZ', AT)).toBeNull();
    reply([]);
    expect(await new BinancePriceProvider().getPriceAt('BTC', AT)).toBeNull();
    reply([['pas', 'une', 'bougie']]);
    expect(await new BinancePriceProvider().getPriceAt('BTC', AT)).toBeNull();
    reply(candle(MINUTE, '0'));
    expect(await new BinancePriceProvider().getPriceAt('BTC', AT)).toBeNull();
  });

  it("renvoie null si l'actif n'était pas encore coté (première bougie bien plus tardive)", async () => {
    // Binance renvoie la première bougie *après* startTime : ici 3 jours plus tard.
    reply(candle(MINUTE + 3 * 24 * 3_600_000));
    expect(await new BinancePriceProvider().getPriceAt('NEW', AT)).toBeNull();
  });

  it('accepte une bougie de quelques minutes plus tard (trou de données)', async () => {
    reply(candle(MINUTE + 2 * 60_000, '100'));
    expect(
      (await new BinancePriceProvider().getPriceAt('BTC', AT))?.toFixed(),
    ).toBe('100');
  });

  it.each([
    ['panne', 503, {}],
    ['limite de débit', 429, {}],
    ['bannissement', 418, {}],
    ['autre erreur HTTP', 400, { code: -1100 }],
  ])('signale une indisponibilité : %s', async (_name, status, body) => {
    reply(body, status);
    await expect(
      new BinancePriceProvider().getPriceAt('BTC', AT),
    ).rejects.toThrow(PriceUnavailableError);
  });

  it('signale une indisponibilité sur erreur réseau ou réponse inattendue, sans la mettre en cache', async () => {
    const provider = new BinancePriceProvider();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );
    await expect(provider.getPriceAt('BTC', AT)).rejects.toThrow(
      PriceUnavailableError,
    );

    reply({ not: 'a list' });
    await expect(provider.getPriceAt('BTC', AT)).rejects.toThrow(
      PriceUnavailableError,
    );

    reply(candle());
    await expect(provider.getPriceAt('BTC', AT)).resolves.not.toBeNull();
  });
});
