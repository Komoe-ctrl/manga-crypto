import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import ccxt from 'ccxt';
import { Prisma } from '../../generated/prisma/client.js';
import { Exchange } from '../../generated/prisma/enums.js';
import { toPair } from '../order-rules.js';
import {
  ExchangeGateway,
  GatewayRejectedError,
  GatewayUnavailableError,
  type GatewayCredentials,
  type GatewayOrder,
  type MarketOrderRequest,
} from './exchange-gateway.js';

/** Sous-ensemble de `ccxt.Exchange` réellement utilisé (permet un faux dans les tests). */
export interface CcxtExchange {
  markets?: unknown;
  loadMarkets(): Promise<unknown>;
  setMarkets(markets: unknown): unknown;
  amountToPrecision(symbol: string, amount: number): string;
  market(symbol: string): { limits?: { amount?: { min?: number } } };
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ): Promise<CcxtOrder>;
  fetchOrder(
    id: string,
    symbol: string,
    params?: Record<string, unknown>,
  ): Promise<CcxtOrder>;
}

export interface CcxtOrder {
  id?: string;
  status?: string;
  filled?: number;
  average?: number;
  cost?: number;
  fee?: { cost?: number; currency?: string };
  fees?: { cost?: number; currency?: string }[];
}

/** Sans `credentials`, une instance publique (données de marché uniquement, aucun appel signé). */
export type CcxtFactory = (
  exchangeId: string,
  credentials?: { apiKey: string; secret: string },
) => CcxtExchange;
export const CCXT_FACTORY = Symbol('CCXT_FACTORY');

const EXCHANGE_IDS: Record<Exchange, string> = {
  [Exchange.BINANCE]: 'binance',
  [Exchange.KRAKEN]: 'kraken',
};
const TIMEOUT_MS = 15_000;
const MARKETS_TTL_MS = 60 * 60_000;

const defaultFactory: CcxtFactory = (exchangeId, credentials) => {
  const Constructor = (
    ccxt as unknown as Record<string, new (config: object) => CcxtExchange>
  )[exchangeId];
  return new Constructor({
    apiKey: credentials?.apiKey,
    secret: credentials?.secret,
    enableRateLimit: true,
    timeout: TIMEOUT_MS,
    options: { defaultType: 'spot' },
  });
};

/**
 * Passage d'ordres via `ccxt`. Le seul module qui parle à la plateforme avec les clés de l'utilisateur.
 * Les erreurs de `ccxt` (dont le message peut citer une URL ou une réponse) sont réduites à un code : refus
 * définitif (`GatewayRejectedError`) ou panne transitoire (`GatewayUnavailableError`).
 */
@Injectable()
export class CcxtGateway extends ExchangeGateway {
  private readonly logger = new Logger(CcxtGateway.name);
  /** Marchés (précisions, minimums) : volumineux à charger, communs à tous les utilisateurs d'une plateforme. */
  private readonly marketsCache = new Map<
    string,
    { at: number; markets: unknown }
  >();

  constructor(
    @Optional()
    @Inject(CCXT_FACTORY)
    private readonly factory: CcxtFactory = defaultFactory,
  ) {
    super();
  }

  async findOrder(
    credentials: GatewayCredentials,
    {
      symbol,
      clientOrderId,
    }: Pick<MarketOrderRequest, 'symbol' | 'clientOrderId'>,
  ): Promise<GatewayOrder | null> {
    const exchange = this.build(credentials);
    try {
      const order = await exchange.fetchOrder('', toPair(symbol), {
        origClientOrderId: clientOrderId,
      });
      return toGatewayOrder(order);
    } catch (error) {
      if (error instanceof ccxt.OrderNotFound) return null;
      throw this.translate(error);
    }
  }

  async placeMarketOrder(
    credentials: GatewayCredentials,
    request: MarketOrderRequest,
  ): Promise<GatewayOrder> {
    const exchange = this.build(credentials);
    const pair = toPair(request.symbol);

    try {
      await this.loadMarkets(credentials.exchange, exchange);
      // Arrondi à la précision de la paire, puis contrôle du minimum : un ordre sous le minimum serait refusé.
      const amount = Number(this.toPrecision(exchange, pair, request));
      const minimum = exchange.market(pair).limits?.amount?.min ?? 0;
      if (!(amount > 0) || amount < minimum)
        throw new GatewayRejectedError('below_minimum');

      const order = await exchange.createOrder(
        pair,
        'market',
        request.side.toLowerCase(),
        amount,
        undefined,
        {
          newClientOrderId: request.clientOrderId,
        },
      );
      return toGatewayOrder(order);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Arrondit la quantité à la précision de la paire. `ccxt` lève `InvalidOrder` quand l'arrondi tombe à zéro (quantité
   * plus petite que le pas) : c'est « sous le minimum », pas un ordre invalide au sens de la plateforme.
   */
  private toPrecision(
    exchange: CcxtExchange,
    pair: string,
    request: MarketOrderRequest,
  ): string {
    try {
      return exchange.amountToPrecision(pair, request.quantity.toNumber());
    } catch (error) {
      if (error instanceof ccxt.InvalidOrder)
        throw new GatewayRejectedError('below_minimum');
      throw error;
    }
  }

  private build(credentials: GatewayCredentials): CcxtExchange {
    return this.factory(EXCHANGE_IDS[credentials.exchange], {
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
    });
  }

  private async loadMarkets(
    id: Exchange,
    exchange: CcxtExchange,
  ): Promise<void> {
    const cached = this.marketsCache.get(id);
    if (cached && Date.now() - cached.at < MARKETS_TTL_MS) {
      exchange.setMarkets(cached.markets);
      return;
    }
    // Les marchés (précisions, minimums) sont des données publiques : on les charge avec une instance **sans clés**.
    // Avec des clés, `ccxt` ajoute un appel signé au chargement ; s'il échoue (clé refusée), il masquerait tout le reste.
    const publicExchange = this.factory(EXCHANGE_IDS[id]);
    await publicExchange.loadMarkets();
    this.marketsCache.set(id, {
      at: Date.now(),
      markets: publicExchange.markets,
    });
    exchange.setMarkets(publicExchange.markets);
  }

  private translate(error: unknown): Error {
    if (
      error instanceof GatewayRejectedError ||
      error instanceof GatewayUnavailableError
    )
      return error;
    // Le message de `ccxt` peut contenir l'URL ou la réponse de la plateforme : seul le nom de l'erreur est gardé.
    this.logger.warn(
      `Erreur de la plateforme : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
    );

    if (error instanceof ccxt.InsufficientFunds)
      return new GatewayRejectedError('insufficient_funds');
    if (
      error instanceof ccxt.AuthenticationError ||
      error instanceof ccxt.PermissionDenied
    ) {
      return new GatewayRejectedError('exchange_auth');
    }
    if (error instanceof ccxt.BadSymbol)
      return new GatewayRejectedError('invalid_symbol');
    if (error instanceof ccxt.InvalidOrder)
      return new GatewayRejectedError('invalid_order');
    // Réseau, délai, limite de débit, plateforme indisponible, erreur inconnue : transitoire, on réessaie.
    return new GatewayUnavailableError();
  }
}

/** Normalise un ordre `ccxt`. Les frais peuvent être agrégés (`fee`) ou détaillés (`fees`). */
function toGatewayOrder(order: CcxtOrder): GatewayOrder {
  const filled = new Prisma.Decimal(order.filled ?? 0);
  const average =
    order.average && order.average > 0
      ? new Prisma.Decimal(order.average)
      : order.cost && filled.gt(0)
        ? new Prisma.Decimal(order.cost).div(filled)
        : null;

  const fee = order.fee?.cost !== undefined ? order.fee : order.fees?.[0];
  return {
    exchangeOrderId: order.id ?? null,
    status: normalizeStatus(order.status),
    filled,
    average: filled.gt(0) ? average : null,
    feeCost: fee?.cost !== undefined ? new Prisma.Decimal(fee.cost) : null,
    feeCurrency: fee?.currency ?? null,
  };
}

function normalizeStatus(status: string | undefined): GatewayOrder['status'] {
  switch (status) {
    case 'closed':
      return 'closed';
    case 'canceled':
    case 'expired':
      return 'canceled';
    case 'rejected':
      return 'rejected';
    default:
      return 'open';
  }
}
