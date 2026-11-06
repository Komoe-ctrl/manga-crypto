import { generateKeyPairSync, verify } from 'node:crypto';
import { CoinbaseVerifier, coinbaseJwt } from './coinbase.verifier.js';
import {
  ExchangeUnavailableError,
  InvalidCredentialsError,
} from './exchange-verifier.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const pem = privateKey.export({ type: 'sec1', format: 'pem' }).toString();
const credentials = {
  apiKey: 'organizations/org-1/apiKeys/key-1',
  apiSecret: pem,
};

const permissions = { can_view: true, can_trade: true, can_transfer: false };

const reply = (status: number, body: unknown) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('coinbaseJwt', () => {
  it('produit un JWT ES256 vérifiable, lié à une seule requête', () => {
    const jwt = coinbaseJwt(
      credentials,
      'GET',
      'api.coinbase.com',
      '/p',
      1_000_000,
    );
    const [header, payload, signature] = jwt.split('.') as [
      string,
      string,
      string,
    ];
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<
        string,
        unknown
      >;

    expect(decode(header)).toMatchObject({
      alg: 'ES256',
      kid: credentials.apiKey,
      typ: 'JWT',
    });
    expect(decode(payload)).toEqual({
      sub: credentials.apiKey,
      iss: 'cdp',
      nbf: 1000,
      exp: 1120,
      uri: 'GET api.coinbase.com/p',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('accepte un PEM écrit sur une ligne avec des « \\n » littéraux', () => {
    const oneLine = pem.trim().replaceAll('\n', '\\n');
    expect(() =>
      coinbaseJwt({ ...credentials, apiSecret: oneLine }, 'GET', 'h', '/p'),
    ).not.toThrow();
  });
});

describe('CoinbaseVerifier', () => {
  const verifier = new CoinbaseVerifier();

  afterEach(() => vi.restoreAllMocks());

  it('relève read et trade, sans transfert', async () => {
    reply(200, permissions);
    await expect(verifier.verify(credentials, false)).resolves.toEqual({
      permissions: ['read', 'trade'],
      withdrawalEnabled: false,
      verified: true,
    });
  });

  it('traite le droit de transfert comme un droit de retrait', async () => {
    reply(200, { ...permissions, can_transfer: true });
    await expect(verifier.verify(credentials, false)).resolves.toMatchObject({
      withdrawalEnabled: true,
    });
  });

  it('envoie un jeton Bearer et jamais la clé privée', async () => {
    const spy = reply(200, permissions);
    await verifier.verify(credentials, false);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.coinbase.com/api/v3/brokerage/key_permissions',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('PRIVATE KEY');
  });

  it('ne contacte pas la plateforme en sandbox', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(verifier.verify(credentials, true)).resolves.toMatchObject({
      verified: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuse une clé privée illisible sans appeler la plateforme', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(
      verifier.verify(
        { ...credentials, apiSecret: 'pas-un-pem-valide' },
        false,
      ),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('traduit un refus de la plateforme en clé invalide', async () => {
    reply(401, { error: 'UNAUTHENTICATED' });
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it.each([
    ['panne', 503],
    ['limite de débit', 429],
  ])('traite « %s » comme une indisponibilité', async (_name, status) => {
    reply(status, {});
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      ExchangeUnavailableError,
    );
  });

  it('traite une erreur réseau comme une indisponibilité', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      ExchangeUnavailableError,
    );
  });

  it("n'interprète jamais un champ absent comme « pas de transfert »", async () => {
    const { can_transfer: _omitted, ...incomplete } = permissions;
    reply(200, incomplete);
    await expect(verifier.verify(credentials, false)).rejects.toThrow(
      ExchangeUnavailableError,
    );
  });
});
