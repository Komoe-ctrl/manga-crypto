import { vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { ExitMonitor } from '../../src/orders/exit-monitor.js';
import {
  ExchangeGateway,
  type GatewayCredentials,
  type GatewayOrder,
  type MarketOrderRequest,
} from '../../src/orders/gateway/exchange-gateway.js';
import { InlineOrderDispatcher } from '../../src/orders/order-dispatcher.js';
import { OrderExecutor } from '../../src/orders/order-executor.js';
import { OrdersService } from '../../src/orders/orders.service.js';
import type { NotificationService } from '../../src/notifications/notification.service.js';
import { PortfolioValuationService } from '../../src/portfolio/portfolio-valuation.service.js';
import { PortfolioService } from '../../src/portfolio/portfolio.service.js';
import { PriceUnavailableError } from '../../src/portfolio/price/price-provider.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { RiskSettingsService } from '../../src/risk/risk-settings.service.js';
import { TradingControlService } from '../../src/risk/trading-control.service.js';
import type { ExchangesService } from '../../src/exchanges/exchanges.service.js';
import { FakePrisma } from './fake-prisma.js';

const D = (value: number | string) => new Prisma.Decimal(value);

/** Fausse plateforme : mémorise les ordres par `clientOrderId`, comme le ferait Binance. */
export class FakeGateway extends ExchangeGateway {
  readonly orders = new Map<string, GatewayOrder>();
  readonly placeCalls: MarketOrderRequest[] = [];
  findCalls = 0;
  /** Erreur levée par la recherche. */
  findError: Error | null = null;
  /** Erreur levée à la création, avant que l'ordre n'existe. */
  placeError: Error | null = null;
  /** L'ordre est créé sur la plateforme mais la réponse se perd (erreur réseau) : le cas qui fait doubler un ordre. */
  loseResponse: Error | null = null;
  /** Résultat de la création ; par défaut : exécuté en entier au prix courant, frais de 0,1 % en USDT. */
  result: ((request: MarketOrderRequest) => GatewayOrder) | null = null;

  constructor(private readonly priceOf: (symbol: string) => number) {
    super();
  }

  async findOrder(
    _credentials: GatewayCredentials,
    { clientOrderId }: Pick<MarketOrderRequest, 'symbol' | 'clientOrderId'>,
  ): Promise<GatewayOrder | null> {
    this.findCalls++;
    if (this.findError) throw this.findError;
    return this.orders.get(clientOrderId) ?? null;
  }

  async placeMarketOrder(
    _credentials: GatewayCredentials,
    request: MarketOrderRequest,
  ): Promise<GatewayOrder> {
    this.placeCalls.push(request);
    if (this.placeError) throw this.placeError;
    const order = (this.result ?? this.defaultResult)(request);
    this.orders.set(request.clientOrderId, order);
    if (this.loseResponse) throw this.loseResponse;
    return order;
  }

  private defaultResult = (request: MarketOrderRequest): GatewayOrder => {
    const price = D(this.priceOf(request.symbol));
    return {
      exchangeOrderId: `ex-${this.placeCalls.length}`,
      status: 'closed',
      filled: request.quantity,
      average: price,
      feeCost: request.quantity.mul(price).mul('0.001').toDecimalPlaces(8),
      feeCurrency: 'USDT',
    };
  };
}

export interface HarnessOptions {
  timezone?: string;
  /** `inline` : l'ordre est exécuté dès sa création ; `manual` : il reste PENDING, le test appelle l'exécuteur. */
  dispatch?: 'inline' | 'manual';
}

/**
 * Banc d'essai du module d'ordres : base en mémoire, vrais services (portefeuille, risques, audit), faux prix,
 * fausse plateforme et notifications espionnées. Prix par défaut : BTC 100, ETH 3 000.
 */
export async function buildOrders({
  timezone = 'UTC',
  dispatch = 'inline',
}: HarnessOptions = {}) {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const audit = new AuditService(asPrisma);
  const portfolio = new PortfolioService(asPrisma, audit);

  // Les stablecoins valent 1, comme avec le vrai fournisseur de prix.
  const market: Record<string, number | null> = {
    BTC: 100,
    ETH: 3000,
    USDT: 1,
    USDC: 1,
  };
  const state = { pricesDown: false };
  const provider = {
    getPrices: vi.fn(async (symbols: string[]) => {
      if (state.pricesDown) throw new PriceUnavailableError();
      return new Map(
        symbols.map((s) => [s, market[s] == null ? null : D(market[s]!)]),
      );
    }),
    getPriceAt: vi.fn(async (_symbol: string, _at: Date) => null),
  };

  const valuation = new PortfolioValuationService(portfolio, provider);
  const control = new TradingControlService(
    asPrisma,
    new PasswordService(),
    audit,
  );
  const riskSettings = new RiskSettingsService(asPrisma, audit);
  const notifications = {
    notify: vi.fn(async (_userId: string, _input: object) => null),
  };
  const credentials = {
    configId: 'exchange-config-1',
    exchange: 'BINANCE' as const,
    apiKey: 'PUBLIC-KEY-123456',
    apiSecret: 'TOP-SECRET-VALUE-XYZ',
  };
  const exchanges = {
    getLiveCredentials: vi.fn(
      async (_userId: string): Promise<typeof credentials | null> =>
        credentials,
    ),
  };
  const gateway = new FakeGateway((symbol) => market[symbol] ?? 0);

  const executor = new OrderExecutor(
    asPrisma,
    portfolio,
    provider,
    control,
    riskSettings,
    exchanges as unknown as ExchangesService,
    gateway,
    audit,
    notifications as unknown as NotificationService,
  );
  const inline = new InlineOrderDispatcher(executor);
  const dispatched: string[] = [];
  const dispatcher = {
    dispatch: vi.fn(async (id: string) => {
      dispatched.push(id);
      if (dispatch === 'inline') await inline.dispatch(id);
    }),
  };

  const orders = new OrdersService(
    asPrisma,
    portfolio,
    valuation,
    provider,
    control,
    riskSettings,
    dispatcher,
    audit,
  );
  const monitor = new ExitMonitor(
    asPrisma,
    provider,
    orders,
    portfolio,
    control,
    audit,
    notifications as unknown as NotificationService,
  );

  const user = await prisma.user.create({
    data: { email: 'a@example.com', passwordHash: 'x', timezone },
    select: { id: true },
  });
  const userId = user.id as string;

  return {
    prisma,
    userId,
    market,
    state,
    provider,
    notifications,
    exchanges,
    credentials,
    gateway,
    executor,
    orders,
    monitor,
    control,
    dispatcher,
    dispatched,
    audit: audit,
    /** Déclare un capital en USDT. */
    fund: (quantity: number | string) =>
      portfolio.setAsset(
        userId,
        'USDT',
        { quantity: String(quantity), avgBuyPrice: '1' },
        {},
      ),
    /** Déclare une position. */
    hold: (
      symbol: string,
      quantity: number | string,
      avgBuyPrice: number | string = 100,
    ) =>
      portfolio.setAsset(
        userId,
        symbol,
        { quantity: String(quantity), avgBuyPrice: String(avgBuyPrice) },
        {},
      ),
    quantityOf: async (symbol: string): Promise<string> =>
      (await portfolio.list(userId))
        .find((h) => h.symbol === symbol)
        ?.quantity.toString() ?? '0',
    goLive: () => {
      prisma.users[0].tradingMode = 'LIVE';
    },
    actions: () => prisma.auditLogs.map((l) => l.action as string),
  };
}

export type OrdersHarness = Awaited<ReturnType<typeof buildOrders>>;
