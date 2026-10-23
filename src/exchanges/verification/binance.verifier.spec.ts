import { createHmac } from 'node:crypto';
import { BinanceVerifier } from './binance.verifier.js';
import {
  ExchangeUnavailableError,
  InvalidCredentialsError,
} from './exchange-verifier.js';

const credentials = {
  apiKey: 'public-key-1234',
  apiSecret: 'very-secret-value',
};

const restrictions = {
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  enableSpotAndMarginTrading: true,
  enableMargin: false,
  enableFutures: false,
  permitsUniversalTransfer: false,
};

const reply = (status: number, body: unknown) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('BinanceVerifier', () => {
  const verifier = new BinanceVerifier();

  afterEach(() => vi.restoreAllMocks());

  it('relève read et trade, sans retrait', async () => {
    reply(200, restrictions);
    await expect(verifier.verify(credentials, false)).resolves.toEqual({
      permissions: ['read', 'trade'],
      withdrawalEnabled: false,
      verified: true,
    });
  });

  it('signale le droit de retrait', async () => {
    reply(200, { ...restrictions, enableWithdrawals: true });
    await expect(verifier.verify(credentials, false)).resolves.toMatchObject({
      withdrawalEnabled: true,
    });
  });

  it('envoie une requête signée sans exposer le secret', async () => {
    const spy = reply(200, restrictions);
    await verifier.verify(credentials, false);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://api.binance.com/sapi/v1/account/apiRestrictions',
    );
    expect((init.headers as Record<string, string>)['X-MBX-APIKEY']).toBe(
      credentials.apiKey,
    );
    expect(url).not.toContain(credentials.apiSecret);

    const signature = parsed.searchParams.get('signature');
    const signed = `timestamp=${parsed.searchParams.get('timestamp')}&recvWindow=5000`;
    expect(signature).toBe(
      createHmac('sha256', credentials.apiSecret).update(signed).digest('hex'),
    );
  });

  it('ne contacte pas la plateforme pour un testnet et marque la clé non vérifiée', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(verifier.verify(credentials, true)).resolves.toMatchObject({
      withdrawalEnabled: false,
      verified: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('traduit un refus de la plateforme en clé invalide', async () => {
    reply(401, {
      code: -2015,
      msg: 'Invalid API-key, IP, or permissions for action.',
    });
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it.each([
    ['panne', 503, {}],
    ['limite de débit', 429, {}],
    ['horloge décalée', 400, { code: -1021 }],
  ])(
    'traite « %s » comme une indisponibilité, pas comme une clé invalide',
    async (_name, status, body) => {
      reply(status, body);
      await expect(verifier.verify(credentials, false)).rejects.toThrow(
        ExchangeUnavailableError,
      );
    },
  );

  it('traite une erreur réseau comme une indisponibilité', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      ExchangeUnavailableError,
    );
  });

  it("n'interprète jamais un champ absent comme « pas de retrait »", async () => {
    const { enableWithdrawals: _omitted, ...incomplete } = restrictions;
    reply(200, incomplete);
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      ExchangeUnavailableError,
    );
    reply(200, 'n’importe quoi');
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      ExchangeUnavailableError,
    );
  });
});
