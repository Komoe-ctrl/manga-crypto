import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { Prisma, type TradeLog } from '../generated/prisma/client.js';
import {
  OrderOrigin,
  OrderSide,
  OrderStatus,
  OrderType,
  TradingMode,
} from '../generated/prisma/enums.js';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from '../portfolio/price/price-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RiskSettingsService } from '../risk/risk-settings.service.js';
import { exceedsExposure } from '../risk/risk-rules.js';
import { TradingControlService } from '../risk/trading-control.service.js';
import { OrderDispatcher } from './order-dispatcher.js';
import {
  PAPER_FEE_RATE,
  QUOTE,
  STABLECOINS,
  isRejectionReason,
  newClientOrderId,
  toPair,
  type RejectionReason,
} from './order-rules.js';
import type { OrderIntent, OrderView } from './orders.types.js';

const D = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value);

/**
 * Création des ordres. **Point d'entrée unique** : l'API manuelle, le futur consommateur de signaux et la
 * surveillance des stop-loss / take-profit passent tous par `submit`, donc par les mêmes garde-fous.
 *
 * Un ordre refusé n'est jamais perdu en silence : il est enregistré (`REJECTED`) avec son motif.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly valuation: PortfolioValuationService,
    private readonly prices: PriceProvider,
    private readonly control: TradingControlService,
    private readonly riskSettings: RiskSettingsService,
    private readonly dispatcher: OrderDispatcher,
    private readonly audit: AuditService,
  ) {}

  /** Vérifie les garde-fous, enregistre l'ordre (avec son `clientOrderId` idempotent) puis l'envoie à l'exécution. */
  async submit(
    userId: string,
    intent: OrderIntent,
    ctx: RequestContext = {},
  ): Promise<OrderView> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { tradingMode: true },
    });
    if (!user) throw new NotFoundException();

    const rejection = await this.check(userId, user.tradingMode, intent);
    const row = await this.prisma.tradeLog.create({
      data: {
        userId,
        clientOrderId: newClientOrderId(),
        mode: user.tradingMode,
        symbol: toPair(intent.symbol),
        side: intent.side,
        type: OrderType.MARKET,
        quantity: intent.quantity,
        origin: intent.origin,
        parentOrderId: intent.parentOrderId,
        signalStreamId: intent.signalStreamId,
        signalPayload: intent.signalPayload,
        status: rejection ? OrderStatus.REJECTED : OrderStatus.PENDING,
        failureReason: rejection,
      },
    });

    await this.audit.log({
      userId,
      action: rejection ? 'order.rejected' : 'order.submitted',
      entityType: 'TradeLog',
      entityId: row.id,
      metadata: {
        symbol: row.symbol,
        side: row.side,
        quantity: intent.quantity.toFixed(),
        mode: row.mode,
        origin: row.origin,
        ...(rejection && { reason: rejection }),
      },
      ...ctx,
    });

    if (rejection) return toView(row);
    await this.dispatcher.dispatch(row.id);
    // L'exécution peut déjà être terminée (PAPER, ou file désactivée) : on renvoie l'état à jour.
    return toView(
      (await this.prisma.tradeLog.findUnique({ where: { id: row.id } })) ?? row,
    );
  }

  async list(
    userId: string,
    options: { limit: number; before?: Date; status?: OrderStatus },
  ): Promise<{ items: OrderView[] }> {
    const rows = await this.prisma.tradeLog.findMany({
      where: {
        userId,
        ...(options.status && { status: options.status }),
        ...(options.before && { createdAt: { lt: options.before } }),
      },
      orderBy: { createdAt: 'desc' },
      take: options.limit,
    });
    return { items: rows.map(toView) };
  }

  async get(userId: string, id: string): Promise<OrderView> {
    return toView(await this.findOwned(userId, id));
  }

  /** Annule un ordre pas encore pris par l'exécution (`PENDING`). Un ordre déjà parti ne s'annule pas (ordre au marché). */
  async cancel(
    userId: string,
    id: string,
    ctx: RequestContext = {},
  ): Promise<OrderView> {
    await this.findOwned(userId, id);
    const cancelled = await this.prisma.tradeLog.updateMany({
      where: { id, userId, status: OrderStatus.PENDING },
      data: { status: OrderStatus.CANCELLED },
    });
    if (cancelled.count !== 1)
      throw new ConflictException(
        "L'ordre est déjà en cours d'exécution ou terminé : il ne peut plus être annulé",
      );

    await this.audit.log({
      userId,
      action: 'order.cancelled',
      entityType: 'TradeLog',
      entityId: id,
      ...ctx,
    });
    return this.get(userId, id);
  }

  /**
   * Garde-fous, dans l'ordre : mode, symbole, robot actif (kill switch, pause), puis selon le sens.
   * Achat : prix, capital connu, exposition maximale par position, fonds (PAPER). Vente : quantité détenue.
   * @returns le motif du refus, ou `null` si l'ordre peut partir.
   */
  private async check(
    userId: string,
    mode: TradingMode,
    intent: OrderIntent,
  ): Promise<RejectionReason | null> {
    // Tant que le consommateur de signaux n'existe pas, aucun ordre manuel n'est possible en réel.
    if (intent.origin === OrderOrigin.MANUAL && mode === TradingMode.LIVE)
      return 'manual_orders_paper_only';
    if (STABLECOINS.has(intent.symbol)) return 'symbol_not_tradable';

    const status = await this.control.status(userId);
    if (status.blockedReason === 'KILL_SWITCH') return 'kill_switch';
    if (status.blockedReason === 'PAUSED_DAILY_LOSS')
      return 'paused_daily_loss';

    const holdings = new Map(
      (await this.portfolio.list(userId)).map((h) => [h.symbol, D(h.quantity)]),
    );

    if (intent.side === OrderSide.SELL) {
      return (holdings.get(intent.symbol) ?? D(0)).lt(intent.quantity)
        ? 'insufficient_quantity'
        : null;
    }

    const price = await this.price(intent.symbol);
    if (!price) return 'price_unavailable';

    const capital = await this.valuation.totalValue(userId);
    if (!capital) return 'capital_unknown';
    // Sans capital déclaré, il n'y a rien à engager : « fonds insuffisants » est plus clair qu'« exposition dépassée ».
    if (capital.lte(0)) return 'insufficient_funds';

    // « Impossible d'engager plus de X % du capital total sur une position » : position existante + cet achat.
    const maxExposurePct = (await this.riskSettings.get(userId)).maxExposurePct;
    const positionAfter = (holdings.get(intent.symbol) ?? D(0))
      .plus(intent.quantity)
      .mul(price);
    if (exceedsExposure(positionAfter, capital, maxExposurePct))
      return 'exposure_exceeded';

    // En PAPER, l'achat est payé avec l'USDT du portefeuille déclaré ; en LIVE, la plateforme fait foi.
    if (mode === TradingMode.PAPER) {
      const cost = intent.quantity.mul(price).mul(D(1).plus(PAPER_FEE_RATE));
      if ((holdings.get(QUOTE) ?? D(0)).lt(cost)) return 'insufficient_funds';
    }
    return null;
  }

  private async price(symbol: string): Promise<Prisma.Decimal | null> {
    try {
      return (await this.prices.getPrices([symbol])).get(symbol) ?? null;
    } catch (error) {
      if (error instanceof PriceUnavailableError) return null;
      throw error;
    }
  }

  private async findOwned(userId: string, id: string): Promise<TradeLog> {
    const row = await this.prisma.tradeLog.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException();
    return row;
  }
}

const str = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : D(value).toFixed();

export function toView(row: TradeLog): OrderView {
  return {
    id: row.id,
    clientOrderId: row.clientOrderId,
    mode: row.mode,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    status: row.status,
    origin: row.origin,
    quantity: D(row.quantity).toFixed(),
    filledQuantity: D(row.filledQuantity).toFixed(),
    avgFillPrice: str(row.avgFillPrice),
    fee: str(row.fee),
    feeCurrency: row.feeCurrency,
    stopLossPrice: str(row.stopLossPrice),
    takeProfitPrice: str(row.takeProfitPrice),
    failureReason: isRejectionReason(row.failureReason)
      ? row.failureReason
      : row.failureReason,
    parentOrderId: row.parentOrderId,
    createdAt: row.createdAt,
    executedAt: row.executedAt,
  };
}
