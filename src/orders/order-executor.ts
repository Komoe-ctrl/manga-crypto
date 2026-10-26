import { Injectable, Logger, Optional } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { formatNumber } from '../common/format.js';
import { ExchangesService } from '../exchanges/exchanges.service.js';
import { Prisma, type TradeLog } from '../generated/prisma/client.js';
import {
  OrderOrigin,
  OrderSide,
  OrderStatus,
  TradingMode,
} from '../generated/prisma/enums.js';
import { NotificationService } from '../notifications/notification.service.js';
import { TransactionSide } from '../portfolio/dto/portfolio.dto.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from '../portfolio/price/price-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeBus } from '../realtime/realtime-events.js';
import { RiskSettingsService } from '../risk/risk-settings.service.js';
import { stopLossTakeProfit, type DecimalInput } from '../risk/risk-rules.js';
import { TradingControlService } from '../risk/trading-control.service.js';
import {
  ExchangeGateway,
  GatewayRejectedError,
  GatewayUnavailableError,
  type GatewayOrder,
} from './gateway/exchange-gateway.js';
import {
  QUOTE,
  REJECTION_MESSAGES,
  paperFee,
  type RejectionReason,
} from './order-rules.js';
import { toView } from './order-view.js';
import { RetryableOrderError } from './orders.types.js';

const D = (value: DecimalInput) => new Prisma.Decimal(value);

/** État à enregistrer sur l'ordre après un passage (PAPER ou réponse de la plateforme). */
interface Fill {
  status: OrderStatus;
  /** Faux : l'ordre est encore ouvert sur la plateforme, on réessaiera de le réconcilier. */
  settled: boolean;
  filled: Prisma.Decimal;
  average: Prisma.Decimal | null;
  feeCost: Prisma.Decimal | null;
  feeCurrency: string | null;
  exchangeOrderId: string | null;
  exchangeConfigId?: string;
}

/**
 * Exécution d'un ordre enregistré. Idempotente : un ordre n'est « pris » (`PENDING` → `SUBMITTED`) qu'une fois, et un
 * nouvel essai d'un ordre déjà parti **retrouve** l'ordre sur la plateforme par son `clientOrderId` avant d'en créer un.
 *
 * - PAPER : exécution simulée au prix courant, frais fictifs de 0,1 %.
 * - LIVE : ordre au marché réel via `ExchangeGateway`, clés déchiffrées par `ExchangesService` à chaque ordre.
 * Dans les deux modes, le portefeuille déclaré est mis à jour (actif et USDT) à chaque exécution.
 */
@Injectable()
export class OrderExecutor {
  private readonly logger = new Logger(OrderExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly prices: PriceProvider,
    private readonly control: TradingControlService,
    private readonly riskSettings: RiskSettingsService,
    private readonly exchanges: ExchangesService,
    private readonly gateway: ExchangeGateway,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Optional() private readonly realtime?: RealtimeBus,
  ) {}

  /** @throws RetryableOrderError pour un problème transitoire (prix, plateforme, ordre pas encore soldé). */
  async execute(id: string): Promise<void> {
    const order = await this.prisma.tradeLog.findUnique({ where: { id } });
    if (
      !order ||
      (order.status !== OrderStatus.PENDING &&
        order.status !== OrderStatus.SUBMITTED &&
        order.status !== OrderStatus.PARTIALLY_FILLED)
    ) {
      return; // déjà traité ou inconnu
    }

    let claimedNow = false;
    if (order.status === OrderStatus.PENDING) {
      // Les garde-fous sont revérifiés au moment d'agir : le kill switch ou le mode ont pu changer depuis la création.
      const user = await this.prisma.user.findFirst({
        where: { id: order.userId, deletedAt: null },
        select: { tradingMode: true },
      });
      if (
        !user ||
        (order.mode === TradingMode.LIVE &&
          user.tradingMode !== TradingMode.LIVE)
      ) {
        return this.reject(order, 'mode_changed');
      }
      const blocked = await this.blockedReason(order.userId);
      if (blocked) return this.reject(order, blocked);

      const claimed = await this.prisma.tradeLog.updateMany({
        where: { id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.SUBMITTED },
      });
      if (claimed.count !== 1) return; // pris par un autre passage
      claimedNow = true;
      await this.emitOrder(id);
    }

    // Un ordre déjà parti (SUBMITTED d'un essai précédent) n'est jamais abandonné pour un garde-fou : il se réconcilie.
    if (order.mode === TradingMode.PAPER) await this.fillPaper(order);
    else await this.fillLive(order, claimedNow);
  }

  /**
   * Dernier essai épuisé. Un ordre qui n'a jamais atteint la plateforme est marqué en échec ; un ordre LIVE
   * peut être parti sans qu'on en ait la réponse : il reste en l'état et l'utilisateur est prévenu de le vérifier.
   */
  async giveUp(id: string): Promise<void> {
    const order = await this.prisma.tradeLog.findUnique({ where: { id } });
    if (!order) return;

    const reachedExchange =
      order.mode === TradingMode.LIVE && order.status !== OrderStatus.PENDING;
    if (reachedExchange && order.status !== OrderStatus.FAILED) {
      await this.audit.log({
        userId: order.userId,
        action: 'order.unsettled',
        entityType: 'TradeLog',
        entityId: order.id,
        metadata: { clientOrderId: order.clientOrderId, status: order.status },
      });
      await this.notify(order, {
        title: 'Ordre à vérifier sur la plateforme',
        body: `L'ordre ${order.symbol} (${order.clientOrderId}) a peut-être été exécuté mais son état n'a pas pu être confirmé. Vérifiez-le sur votre plateforme.`,
        critical: true,
        key: 'unsettled',
      });
      return;
    }

    if (
      order.status !== OrderStatus.PENDING &&
      order.status !== OrderStatus.SUBMITTED
    )
      return;
    await this.prisma.tradeLog.updateMany({
      where: {
        id,
        status: { in: [OrderStatus.PENDING, OrderStatus.SUBMITTED] },
      },
      data: { status: OrderStatus.FAILED, failureReason: 'retries_exhausted' },
    });
    await this.audit.log({
      userId: order.userId,
      action: 'order.failed',
      entityType: 'TradeLog',
      entityId: order.id,
      metadata: { reason: 'retries_exhausted', mode: order.mode },
    });
    await this.emitOrder(order.id);
    if (order.mode === TradingMode.LIVE || isExit(order.origin)) {
      await this.notify(order, {
        title: 'Ordre abandonné',
        body: REJECTION_MESSAGES.retries_exhausted,
        critical: true,
        key: 'failed',
      });
    }
  }

  // ─── PAPER ───────────────────────────────────────────────────────────────────────────────────────────────

  private async fillPaper(order: TradeLog): Promise<void> {
    const base = baseOf(order.symbol);
    const price = (await this.currentPrices([base])).get(base);
    if (!price) throw new RetryableOrderError('price_unavailable');

    const quantity = D(order.quantity);
    const notional = quantity.mul(price);
    const fee = paperFee(notional);
    const held = await this.heldQuantities(order.userId);

    if (
      order.side === OrderSide.BUY &&
      (held.get(QUOTE) ?? D(0)).lt(notional.plus(fee))
    ) {
      return this.reject(order, 'insufficient_funds');
    }
    if (
      order.side === OrderSide.SELL &&
      (held.get(base) ?? D(0)).lt(quantity)
    ) {
      return this.reject(order, 'insufficient_quantity');
    }

    await this.applyFill(order, {
      status: OrderStatus.FILLED,
      settled: true,
      filled: quantity,
      average: price,
      feeCost: fee,
      feeCurrency: QUOTE,
      exchangeOrderId: null,
    });
  }

  // ─── LIVE ────────────────────────────────────────────────────────────────────────────────────────────────

  private async fillLive(order: TradeLog, claimedNow: boolean): Promise<void> {
    // Clés déchiffrées à chaque ordre : l'éligibilité (active, vérifiée, hors testnet) n'est pas figée (D28).
    const credentials = await this.exchanges.getLiveCredentials(order.userId);
    if (!credentials) {
      // Si l'ordre vient d'être pris, rien n'est parti : on le refuse. Sinon un essai précédent a pu l'envoyer.
      if (claimedNow) return this.reject(order, 'no_verified_exchange');
      throw new RetryableOrderError('no_credentials');
    }

    const base = baseOf(order.symbol);
    const request = {
      symbol: base,
      side: order.side,
      quantity: D(order.quantity),
      clientOrderId: order.clientOrderId,
    };

    let state: GatewayOrder;
    try {
      // Chercher avant de créer : un essai précédent a pu aboutir sans qu'on en ait reçu la réponse.
      state =
        (await this.gateway.findOrder(credentials, request)) ??
        (await this.gateway.placeMarketOrder(credentials, request));
    } catch (error) {
      if (error instanceof GatewayRejectedError)
        return this.reject(order, error.reason);
      if (error instanceof GatewayUnavailableError)
        throw new RetryableOrderError('exchange_unavailable');
      throw error;
    }

    const fill = toFill(state, credentials.configId);
    if (fill.status === OrderStatus.REJECTED)
      return this.reject(order, 'invalid_order');
    await this.applyFill(order, fill);
    if (!fill.settled) throw new RetryableOrderError('not_settled');
  }

  // ─── Enregistrement et portefeuille ──────────────────────────────────────────────────────────────────────

  private async applyFill(order: TradeLog, fill: Fill): Promise<void> {
    const previousFilled = D(order.filledQuantity);
    const previousFee = D(order.fee ?? 0);
    const delta = fill.filled.minus(previousFilled);
    const feeDelta = fill.feeCost ? fill.feeCost.minus(previousFee) : D(0);

    const protection =
      order.side === OrderSide.BUY &&
      fill.filled.gt(0) &&
      fill.average &&
      order.stopLossPrice === null
        ? await this.protectiveLevels(order.userId, fill.average)
        : null;

    const updated = await this.prisma.tradeLog.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.SUBMITTED, OrderStatus.PARTIALLY_FILLED] },
      },
      data: {
        status: fill.status,
        filledQuantity: fill.filled,
        avgFillPrice: fill.average,
        fee: fill.feeCost,
        feeCurrency: fill.feeCurrency,
        ...(fill.exchangeOrderId && { exchangeOrderId: fill.exchangeOrderId }),
        ...(fill.exchangeConfigId && {
          exchangeConfigId: fill.exchangeConfigId,
        }),
        ...(fill.settled && { executedAt: new Date() }),
        ...(protection && {
          stopLossPrice: protection.stopLoss,
          takeProfitPrice: protection.takeProfit,
        }),
      },
    });
    if (updated.count !== 1) return; // déjà soldé par un autre passage : ne pas appliquer deux fois

    if (delta.gt(0) && fill.average) {
      await this.settleLegs(
        order,
        delta,
        fill.average,
        feeDelta,
        fill.feeCurrency,
      );
    }
    if (fill.settled && fill.status !== OrderStatus.CANCELLED)
      await this.announceFill(order, fill);
    // En dernier : le portefeuille est à jour quand le front est prévenu.
    await this.emitOrder(order.id);
  }

  /** Niveaux de stop-loss et de take-profit d'une entrée, d'après les réglages de risque de l'utilisateur. */
  private async protectiveLevels(userId: string, entry: Prisma.Decimal) {
    const settings = await this.riskSettings.get(userId);
    const { stopLoss, takeProfit } = stopLossTakeProfit(
      'BUY',
      entry,
      settings.defaultStopLossPct,
      settings.defaultTakeProfitPct,
    );
    return {
      stopLoss: stopLoss.toDecimalPlaces(8),
      takeProfit: takeProfit.toDecimalPlaces(8),
    };
  }

  /**
   * Met à jour le portefeuille déclaré : l'actif échangé **et** l'USDT (sans la contrepartie en USDT, le capital
   * gonflerait à chaque achat). Frais en USDT : déduits de la jambe USDT ; frais en actif de base : déduits de la
   * quantité reçue ; autre devise (BNB…) : enregistrés sur l'ordre mais sans effet sur le portefeuille.
   * Une jambe est plafonnée à ce qui est détenu : en LIVE, la plateforme fait foi, pas le portefeuille déclaré.
   */
  private async settleLegs(
    order: TradeLog,
    quantity: Prisma.Decimal,
    price: Prisma.Decimal,
    fee: Prisma.Decimal,
    feeCurrency: string | null,
  ): Promise<void> {
    const base = baseOf(order.symbol);
    const held = await this.heldQuantities(order.userId);
    const feeInQuote = feeCurrency === QUOTE ? fee : D(0);
    const feeInBase = feeCurrency === base ? fee : D(0);

    const legs =
      order.side === OrderSide.BUY
        ? [
            {
              symbol: base,
              side: TransactionSide.BUY,
              quantity: quantity.minus(feeInBase),
              price,
            },
            {
              symbol: QUOTE,
              side: TransactionSide.SELL,
              quantity: Prisma.Decimal.min(
                quantity.mul(price).plus(feeInQuote),
                held.get(QUOTE) ?? D(0),
              ),
              price: D(1),
            },
          ]
        : [
            {
              symbol: base,
              side: TransactionSide.SELL,
              quantity: Prisma.Decimal.min(quantity, held.get(base) ?? D(0)),
              price,
            },
            {
              symbol: QUOTE,
              side: TransactionSide.BUY,
              quantity: quantity.mul(price).minus(feeInQuote),
              price: D(1),
            },
          ];

    for (const leg of legs) {
      if (leg.quantity.lte(0)) continue;
      try {
        await this.portfolio.recordTransaction(
          order.userId,
          {
            symbol: leg.symbol,
            side: leg.side,
            quantity: leg.quantity.toDecimalPlaces(18).toFixed(),
            price: leg.price.toFixed(),
          },
          {},
        );
      } catch (error) {
        // Le portefeuille est déclaratif : un échec de mise à jour ne doit pas défaire un ordre déjà exécuté.
        this.logger.error(
          `Mise à jour du portefeuille en échec (ordre ${order.id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
      }
    }
  }

  private async announceFill(order: TradeLog, fill: Fill): Promise<void> {
    const base = baseOf(order.symbol);
    const average = fill.average ?? D(0);
    const verb = order.side === OrderSide.BUY ? 'Achat' : 'Vente';
    const summary = `${verb} de ${formatNumber(fill.filled)} ${base} à ${formatNumber(average)} $ (${order.mode})`;

    await this.audit.log({
      userId: order.userId,
      action: 'order.filled',
      entityType: 'TradeLog',
      entityId: order.id,
      metadata: {
        symbol: order.symbol,
        side: order.side,
        mode: order.mode,
        origin: order.origin,
        filledQuantity: fill.filled.toFixed(),
        avgFillPrice: average.toFixed(),
        fee: fill.feeCost?.toFixed() ?? null,
      },
    });

    const title =
      order.origin === OrderOrigin.STOP_LOSS
        ? 'Stop-loss exécuté'
        : order.origin === OrderOrigin.TAKE_PROFIT
          ? 'Take-profit exécuté'
          : 'Ordre exécuté';
    await this.notify(order, {
      title,
      body: summary,
      critical: order.origin === OrderOrigin.STOP_LOSS,
      key: 'filled',
    });
  }

  // ─── Refus et utilitaires ────────────────────────────────────────────────────────────────────────────────

  private async reject(
    order: TradeLog,
    reason: RejectionReason,
  ): Promise<void> {
    const updated = await this.prisma.tradeLog.updateMany({
      where: {
        id: order.id,
        status: { in: [OrderStatus.PENDING, OrderStatus.SUBMITTED] },
      },
      data: { status: OrderStatus.REJECTED, failureReason: reason },
    });
    if (updated.count !== 1) return;

    await this.audit.log({
      userId: order.userId,
      action: 'order.rejected',
      entityType: 'TradeLog',
      entityId: order.id,
      metadata: { reason, mode: order.mode, origin: order.origin },
    });
    await this.emitOrder(order.id);
    // Un refus en PAPER d'un ordre manuel est visible dans la réponse de l'API ; en LIVE ou pour une sortie, on prévient.
    if (order.mode === TradingMode.LIVE || isExit(order.origin)) {
      await this.notify(order, {
        title: 'Ordre refusé',
        body: REJECTION_MESSAGES[reason],
        critical: true,
        key: 'rejected',
      });
    }
  }

  /** Pousse l'état à jour de l'ordre au front. Best effort : une panne ici ne doit jamais défaire un ordre. */
  private async emitOrder(id: string): Promise<void> {
    if (!this.realtime) return;
    try {
      const row = await this.prisma.tradeLog.findUnique({ where: { id } });
      if (row)
        this.realtime.publish(row.userId, { type: 'order', data: toView(row) });
    } catch (error) {
      this.logger.warn(
        `Ordre non diffusé au front (${id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
      );
    }
  }

  /** Notification : un échec d'envoi ne doit jamais défaire l'ordre (déjà enregistré). */
  private async notify(
    order: TradeLog,
    message: { title: string; body: string; critical: boolean; key: string },
  ): Promise<void> {
    try {
      await this.notifications.notify(order.userId, {
        title: message.title,
        body: message.body,
        critical: message.critical,
        dedupeKey: `order:${order.id}:${message.key}`,
      });
    } catch (error) {
      this.logger.error(
        `Notification d'ordre non envoyée (${order.id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
      );
    }
  }

  private async blockedReason(
    userId: string,
  ): Promise<'kill_switch' | 'paused_daily_loss' | null> {
    const status = await this.control.status(userId);
    return status.blockedReason === 'KILL_SWITCH'
      ? 'kill_switch'
      : status.blockedReason === 'PAUSED_DAILY_LOSS'
        ? 'paused_daily_loss'
        : null;
  }

  private async currentPrices(
    symbols: string[],
  ): Promise<Map<string, Prisma.Decimal | null>> {
    try {
      return await this.prices.getPrices(symbols);
    } catch (error) {
      if (error instanceof PriceUnavailableError)
        throw new RetryableOrderError('price_unavailable');
      throw error;
    }
  }

  private async heldQuantities(
    userId: string,
  ): Promise<Map<string, Prisma.Decimal>> {
    return new Map(
      (await this.portfolio.list(userId)).map((h) => [h.symbol, D(h.quantity)]),
    );
  }
}

/** « BTC/USDT » → « BTC ». */
export const baseOf = (pair: string): string => pair.split('/')[0];

const isExit = (origin: OrderOrigin): boolean =>
  origin === OrderOrigin.STOP_LOSS || origin === OrderOrigin.TAKE_PROFIT;

/** Traduit l'état d'un ordre de la plateforme en état à enregistrer. */
function toFill(state: GatewayOrder, exchangeConfigId: string): Fill {
  const common = {
    filled: state.filled,
    average: state.average,
    feeCost: state.feeCost,
    feeCurrency: state.feeCurrency,
    exchangeOrderId: state.exchangeOrderId,
    exchangeConfigId,
  };
  const hasFill = state.filled.gt(0);

  switch (state.status) {
    case 'closed':
      return hasFill
        ? { ...common, status: OrderStatus.FILLED, settled: true }
        : { ...common, status: OrderStatus.REJECTED, settled: true };
    case 'canceled':
      return hasFill
        ? { ...common, status: OrderStatus.PARTIALLY_FILLED, settled: true }
        : { ...common, status: OrderStatus.CANCELLED, settled: true };
    case 'rejected':
      return { ...common, status: OrderStatus.REJECTED, settled: true };
    case 'open':
      return {
        ...common,
        status: hasFill ? OrderStatus.PARTIALLY_FILLED : OrderStatus.SUBMITTED,
        settled: false,
      };
  }
}
