import { BinancePriceProvider } from './binance-price.provider.js';
import { PriceUnavailableError } from './price-provider.js';

/** Bougie Binance : [ouverture (ms), open, high, low, close, …]. */
const candle = (close: string, openTime = 0) => [
  openTime,
  '1',
  '1',
  '1',
  close,
];

const reply = (body: unknown, status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );

describe('BinancePriceProvider.getHourlyCloses', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renvoie les clôtures horaires du plus ancien au plus récent, en décimaux exacts', async () => {
    const spy = reply([
      candle('66000.12345678'),
      candle('66100.5'),
      candle('66250'),
    ]);
    const closes = await new BinancePriceProvider().getHourlyCloses('BTC', 168);

    expect(closes?.map((c) => c.toFixed())).toEqual([
      '66000.12345678',
      '66100.5',
      '66250',
    ]);
    const url = new URL(spy.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      'https://api.binance.com/api/v3/klines',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BTCUSDT',
      interval: '1h',
      limit: '168',
    });
  });

  it('plafonne la demande à 168 heures et la borne à 1 au minimum', async () => {
    const spy = reply([candle('1')]);
    const provider = new BinancePriceProvider();
    await provider.getHourlyCloses('BTC', 5000);
    await provider.getHourlyCloses('ETH', 0);

    const limits = spy.mock.calls.map((c) =>
      new URL(c[0] as string).searchParams.get('limit'),
    );
    expect(limits).toEqual(['168', '1']);
  });

  it('ne tient pas de courbe pour un stablecoin et n’appelle pas la plateforme', async () => {
    const spy = reply([candle('1')]);
    expect(await new BinancePriceProvider().getHourlyCloses('USDT', 168)).toBe(
      null,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('met en cache par symbole et durée, y compris l’absence de donnée', async () => {
    const spy = reply([candle('10')]);
    const provider = new BinancePriceProvider();
    await provider.getHourlyCloses('BTC', 168);
    await provider.getHourlyCloses('BTC', 168);
    expect(spy).toHaveBeenCalledTimes(1);
    await provider.getHourlyCloses('BTC', 24); // autre durée
    await provider.getHourlyCloses('ETH', 168); // autre symbole
    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), {
          status: 400,
        }),
    );
    expect(await provider.getHourlyCloses('NOPE', 168)).toBeNull();
    expect(await provider.getHourlyCloses('NOPE', 168)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('une paire inconnue (-1121) n’est pas une panne : null', async () => {
    reply({ code: -1121, msg: 'Invalid symbol.' }, 400);
    expect(await new BinancePriceProvider().getHourlyCloses('NOPE', 168)).toBe(
      null,
    );
  });

  it('une bougie illisible ou à prix nul est ignorée, les autres restent', async () => {
    reply([candle('100'), ['bad'], candle('0'), candle('abc'), candle('110')]);
    const closes = await new BinancePriceProvider().getHourlyCloses('BTC', 168);
    expect(closes?.map((c) => c.toFixed())).toEqual(['100', '110']);
  });

  it('aucune bougie exploitable : null', async () => {
    reply([]);
    expect(await new BinancePriceProvider().getHourlyCloses('BTC', 168)).toBe(
      null,
    );
  });

  it('plateforme en erreur ou injoignable : PriceUnavailableError, et rien n’est mis en cache', async () => {
    const spy = reply({ code: -1003 }, 429);
    const provider = new BinancePriceProvider();
    await expect(provider.getHourlyCloses('BTC', 168)).rejects.toBeInstanceOf(
      PriceUnavailableError,
    );

    spy.mockRejectedValue(new TypeError('fetch failed'));
    await expect(provider.getHourlyCloses('BTC', 168)).rejects.toBeInstanceOf(
      PriceUnavailableError,
    );

    // Une réponse qui n’est pas une liste est aussi une panne.
    spy.mockImplementation(async () => new Response('{}'));
    await expect(provider.getHourlyCloses('BTC', 168)).rejects.toBeInstanceOf(
      PriceUnavailableError,
    );

    // La panne n'a pas été mémorisée : dès que la plateforme répond, le résultat arrive.
    spy.mockImplementation(
      async () => new Response(JSON.stringify([candle('7')])),
    );
    expect((await provider.getHourlyCloses('BTC', 168))?.[0].toFixed()).toBe(
      '7',
    );
  });
});
