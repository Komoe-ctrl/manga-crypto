import ccxt from 'ccxt';
import { Prisma } from '../../generated/prisma/client.js';
import {
  CcxtGateway,
  type CcxtExchange,
  type CcxtOrder,
} from './ccxt.gateway.js';
import {
  GatewayRejectedError,
  GatewayUnavailableError,
  type GatewayCredentials,
} from './exchange-gateway.js';

const credentials: GatewayCredentials = {
  exchange: 'BINANCE',
  apiKey: 'PUBLIC-KEY-123456',
  apiSecret: 'TOP-SECRET-VALUE-XYZ',
};
const request = {
  symbol: 'BTC',
  side: 'BUY' as const,
  quantity: new Prisma.Decimal('0.123456789'),
  clientOrderId: 'vl-abc',
};

const closed: CcxtOrder = {
  id: '42',
  status: 'closed',
  filled: 0.12345,
  average: 70000,
  fee: { cost: 8.64, currency: 'USDT' },
};

function fakeExchange(over: Partial<CcxtExchange> = {}) {
  const exchange = {
    markets: { 'BTC/USDT': {} },
    loadMarkets: vi.fn(async () => undefined),
    setMarkets: vi.fn(),
    amountToPrecision: vi.fn((_symbol: string, amount: number) =>
      amount.toFixed(5),
    ),
    market: vi.fn(() => ({ limits: { amount: { min: 0.00001 } } })),
    createOrder: vi.fn(async (): Promise<CcxtOrder> => closed),
    fetchOrder: vi.fn(async (): Promise<CcxtOrder> => closed),
    ...over,
  } satisfies CcxtExchange;
  const factory = vi.fn(
    (_id: string, _credentials?: { apiKey: string; secret: string }) =>
      exchange,
  );
  return { exchange, factory, gateway: new CcxtGateway(factory) };
}

describe('CcxtGateway', () => {
  describe('placeMarketOrder', () => {
    it('passe un ordre au marché avec le clientOrderId, à la précision de la paire', async () => {
      const { exchange, factory, gateway } = fakeExchange();
      const order = await gateway.placeMarketOrder(credentials, request);

      expect(factory).toHaveBeenCalledWith('binance', {
        apiKey: credentials.apiKey,
        secret: credentials.apiSecret,
      });
      expect(exchange.amountToPrecision).toHaveBeenCalledWith(
        'BTC/USDT',
        0.123456789,
      );
      expect(exchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT',
        'market',
        'buy',
        0.12346,
        undefined,
        {
          newClientOrderId: 'vl-abc',
        },
      );
      expect(order).toMatchObject({ exchangeOrderId: '42', status: 'closed' });
      expect(order.filled.toFixed()).toBe('0.12345');
      expect(order.average?.toFixed()).toBe('70000');
      expect(order.feeCost?.toFixed()).toBe('8.64');
      expect(order.feeCurrency).toBe('USDT');
    });

    it('une vente part en minuscules', async () => {
      const { exchange, gateway } = fakeExchange();
      await gateway.placeMarketOrder(credentials, { ...request, side: 'SELL' });
      expect(exchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT',
        'market',
        'sell',
        expect.any(Number),
        undefined,
        expect.any(Object),
      );
    });

    it('charge les marchés une fois par plateforme, puis les réutilise', async () => {
      const { exchange, gateway } = fakeExchange();
      await gateway.placeMarketOrder(credentials, request);
      await gateway.placeMarketOrder(credentials, request);
      expect(exchange.loadMarkets).toHaveBeenCalledTimes(1);
      // Les marchés sont fournis à l'instance de chaque ordre, la première fois comme les suivantes.
      expect(exchange.setMarkets).toHaveBeenCalledTimes(2);
    });

    it('charge les marchés avec une instance publique, sans aucune clé (un appel signé échouerait sur une clé refusée)', async () => {
      const { factory, gateway } = fakeExchange();
      await gateway.placeMarketOrder(credentials, request);

      const withoutCredentials = factory.mock.calls.filter(
        ([, creds]) => creds === undefined,
      );
      expect(withoutCredentials).toEqual([['binance']]);
      // L'instance qui porte les clés ne charge jamais les marchés elle-même.
      expect(factory.mock.calls[0]).toEqual([
        'binance',
        { apiKey: credentials.apiKey, secret: credentials.apiSecret },
      ]);
    });

    it('une clé refusée n’empêche pas les contrôles locaux : minimum et paire inconnue passent avant l’appel signé', async () => {
      const unknown = fakeExchange({
        amountToPrecision: vi.fn(() => {
          throw new ccxt.BadSymbol('x');
        }),
      });
      await expect(
        unknown.gateway.placeMarketOrder(credentials, request),
      ).rejects.toMatchObject({ reason: 'invalid_symbol' });
      expect(unknown.exchange.createOrder).not.toHaveBeenCalled();
    });

    it('refuse sous le minimum de la plateforme, sans envoyer d’ordre', async () => {
      const { exchange, gateway } = fakeExchange({
        market: vi.fn(() => ({ limits: { amount: { min: 1 } } })),
      });
      await expect(
        gateway.placeMarketOrder(credentials, request),
      ).rejects.toMatchObject({
        name: 'GatewayRejectedError',
        reason: 'below_minimum',
      });
      expect(exchange.createOrder).not.toHaveBeenCalled();
    });

    it('traduit l’InvalidOrder de ccxt à l’arrondi (quantité plus petite que le pas) en « sous le minimum »', async () => {
      const { exchange, gateway } = fakeExchange({
        amountToPrecision: vi.fn(() => {
          throw new ccxt.InvalidOrder(
            'amount must be greater than minimum amount precision of 0.00001',
          );
        }),
      });
      await expect(
        gateway.placeMarketOrder(credentials, request),
      ).rejects.toMatchObject({ reason: 'below_minimum' });
      expect(exchange.createOrder).not.toHaveBeenCalled();
    });

    it('refuse une quantité arrondie à zéro', async () => {
      const { exchange, gateway } = fakeExchange({
        amountToPrecision: vi.fn(() => '0.00000'),
      });
      await expect(
        gateway.placeMarketOrder(credentials, request),
      ).rejects.toMatchObject({ reason: 'below_minimum' });
      expect(exchange.createOrder).not.toHaveBeenCalled();
    });

    it('normalise les frais détaillés, le prix moyen déduit du coût et les statuts', async () => {
      const cases: [CcxtOrder, Record<string, unknown>][] = [
        [
          {
            id: '1',
            status: 'closed',
            filled: 2,
            cost: 200,
            fees: [{ cost: 0.2, currency: 'USDT' }],
          },
          { status: 'closed', feeCurrency: 'USDT' },
        ],
        [
          { id: '2', status: 'open', filled: 0 },
          { status: 'open', average: null, feeCost: null },
        ],
        [{ id: '3', status: 'canceled', filled: 0 }, { status: 'canceled' }],
        [{ id: '4', status: 'expired', filled: 0 }, { status: 'canceled' }],
        [{ id: '5', status: 'rejected', filled: 0 }, { status: 'rejected' }],
        [{ id: '6', filled: 1, average: 5 }, { status: 'open' }],
      ];
      for (const [raw, expected] of cases) {
        const { gateway } = fakeExchange({
          createOrder: vi.fn(async () => raw),
        });
        expect(
          await gateway.placeMarketOrder(credentials, request),
        ).toMatchObject(expected);
      }
      const { gateway } = fakeExchange({
        createOrder: vi.fn(async () => cases[0][0]),
      });
      expect(
        (
          await gateway.placeMarketOrder(credentials, request)
        ).average?.toFixed(),
      ).toBe('100');
    });
  });

  describe('findOrder', () => {
    it('retrouve l’ordre par son clientOrderId', async () => {
      const { exchange, gateway } = fakeExchange();
      const found = await gateway.findOrder(credentials, {
        symbol: 'BTC',
        clientOrderId: 'vl-abc',
      });
      expect(exchange.fetchOrder).toHaveBeenCalledWith('', 'BTC/USDT', {
        origClientOrderId: 'vl-abc',
      });
      expect(found).toMatchObject({ exchangeOrderId: '42', status: 'closed' });
    });

    it('renvoie null quand l’ordre n’existe pas', async () => {
      const { gateway } = fakeExchange({
        fetchOrder: vi.fn(async () => {
          throw new ccxt.OrderNotFound(
            'binance {"code":-2013,"msg":"Order does not exist."}',
          );
        }),
      });
      await expect(
        gateway.findOrder(credentials, {
          symbol: 'BTC',
          clientOrderId: 'vl-abc',
        }),
      ).resolves.toBeNull();
    });

    it('traduit les autres erreurs', async () => {
      const { gateway } = fakeExchange({
        fetchOrder: vi.fn(async () => {
          throw new ccxt.AuthenticationError('invalid key');
        }),
      });
      await expect(
        gateway.findOrder(credentials, {
          symbol: 'BTC',
          clientOrderId: 'vl-abc',
        }),
      ).rejects.toMatchObject({
        reason: 'exchange_auth',
      });
    });
  });

  describe('traduction des erreurs de ccxt', () => {
    const failing = (error: Error) =>
      fakeExchange({ createOrder: vi.fn(async () => Promise.reject(error)) })
        .gateway;
    const place = (gateway: CcxtGateway) =>
      gateway.placeMarketOrder(credentials, request);

    it.each([
      [
        'InsufficientFunds',
        new ccxt.InsufficientFunds('x'),
        'insufficient_funds',
      ],
      ['InvalidOrder', new ccxt.InvalidOrder('x'), 'invalid_order'],
      [
        'AuthenticationError',
        new ccxt.AuthenticationError('x'),
        'exchange_auth',
      ],
      ['PermissionDenied', new ccxt.PermissionDenied('x'), 'exchange_auth'],
      ['BadSymbol', new ccxt.BadSymbol('x'), 'invalid_symbol'],
    ])('%s → refus définitif « %s »', async (_name, error, reason) => {
      const rejection = await place(failing(error)).catch((e) => e);
      expect(rejection).toBeInstanceOf(GatewayRejectedError);
      expect(rejection.reason).toBe(reason);
    });

    it.each([
      ['NetworkError', new ccxt.NetworkError('x')],
      ['RequestTimeout', new ccxt.RequestTimeout('x')],
      ['ExchangeNotAvailable', new ccxt.ExchangeNotAvailable('x')],
      ['RateLimitExceeded', new ccxt.RateLimitExceeded('x')],
      ['DDoSProtection', new ccxt.DDoSProtection('x')],
      ['erreur inconnue', new Error('x')],
    ])('%s → panne transitoire (on réessaie)', async (_name, error) => {
      await expect(place(failing(error))).rejects.toBeInstanceOf(
        GatewayUnavailableError,
      );
    });

    it('ne laisse jamais ni la clé, ni le secret, ni la réponse de la plateforme dans l’erreur', async () => {
      const leaky = new ccxt.AuthenticationError(
        `binance https://api.binance.com/api/v3/order?signature=abc123 {"apiKey":"${credentials.apiKey}","secret":"${credentials.apiSecret}"}`,
      );
      const rejection = await place(failing(leaky)).catch((e) => e);
      const everything = `${rejection.message} ${JSON.stringify(rejection)} ${rejection.stack}`;
      expect(everything).not.toContain(credentials.apiKey);
      expect(everything).not.toContain(credentials.apiSecret);
      expect(everything).not.toContain('signature=abc123');
    });

    it('une erreur de chargement des marchés est traduite aussi', async () => {
      const { gateway } = fakeExchange({
        loadMarkets: vi.fn(async () => {
          throw new ccxt.RequestTimeout('x');
        }),
      });
      await expect(place(gateway)).rejects.toBeInstanceOf(
        GatewayUnavailableError,
      );
    });
  });
});
