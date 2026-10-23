import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  OrderOrigin,
  OrderSide,
  OrderStatus,
} from '../generated/prisma/enums.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from '../portfolio/price/price-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TradingControlService } from '../risk/trading-control.service.js';
import { baseOf } from './order-executor.js';
import { REJECTION_MESSAGES } from './order-rules.js';
import { OrdersService } from './orders.service.js';

export interface ExitRunSummary {
  watched: number;
  triggered: number;
  /** Seuil atteint mais robot arrêté ou en pause : aucune sortie, l'utilisateur est prévenu. */
  blocked: number;
  failed: number;
}

interface OpenPosition {
  id: string;
  userId: string;
  symbol: string;
  filledQuantity: Prisma.Decimal;
  stopLossPrice: Prisma.Decimal;
  takeProfitPrice: Prisma.Decimal;
}

const D = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value);

/**
 * Surveillance des stop-loss et take-profit (SPEC module 2 : « dès qu'un achat est exécuté, les deux seuils sont
 * programmés »). Toutes les minutes, compare le prix courant aux seuils des positions ouvertes et, quand l'un est
 * atteint, vend la quantité de l'entrée par le même chemin que tout autre ordre (donc avec les mêmes garde-fous).
 *
 * Aucun ordre « stop » n'est posé sur la plateforme : le seuil est surveillé ici, à une minute près.
 */
@Injectable()
export class ExitMonitor {
  private readonly logger = new Logger(ExitMonitor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prices: PriceProvider,
    private readonly orders: OrdersService,
    private readonly portfolio: PortfolioService,
    private readonly control: TradingControlService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async run(now: Date = new Date()): Promise<ExitRunSummary> {
    const summary: ExitRunSummary = {
      watched: 0,
      triggered: 0,
      blocked: 0,
      failed: 0,
    };

    const positions = (await this.prisma.tradeLog.findMany({
      where: {
        side: OrderSide.BUY,
        status: { in: [OrderStatus.FILLED, OrderStatus.PARTIALLY_FILLED] },
        exitTriggeredAt: null,
        stopLossPrice: { not: null },
      },
      select: {
        id: true,
        userId: true,
        symbol: true,
        filledQuantity: true,
        stopLossPrice: true,
        takeProfitPrice: true,
      },
    })) as OpenPosition[];
    summary.watched = positions.length;
    if (positions.length === 0) return summary;

    let current: Map<string, Prisma.Decimal | null>;
    try {
      current = await this.prices.getPrices([
        ...new Set(positions.map((p) => baseOf(p.symbol))),
      ]);
    } catch (error) {
      if (error instanceof PriceUnavailableError) return summary; // on ne conclut pas : prochain passage
      throw error;
    }

    for (const position of positions) {
      // Une erreur sur une position ne doit pas empêcher la surveillance des autres.
      try {
        const price = current.get(baseOf(position.symbol));
        if (!price) continue;

        const origin = price.lte(position.stopLossPrice)
          ? OrderOrigin.STOP_LOSS
          : price.gte(position.takeProfitPrice)
            ? OrderOrigin.TAKE_PROFIT
            : null;
        if (!origin) continue;

        const outcome = await this.exit(position, origin, price, now);
        if (outcome === 'triggered') summary.triggered++;
        else if (outcome === 'blocked') summary.blocked++;
      } catch (error) {
        summary.failed++;
        // Nom de l'erreur seulement : un message d'erreur peut embarquer des données.
        this.logger.error(
          `Surveillance de sortie en échec (ordre ${position.id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
      }
    }
    return summary;
  }

  private async exit(
    position: OpenPosition,
    origin: OrderOrigin,
    price: Prisma.Decimal,
    now: Date,
  ): Promise<'triggered' | 'blocked' | 'skipped'> {
    const base = baseOf(position.symbol);
    const label =
      origin === OrderOrigin.STOP_LOSS ? 'Stop-loss' : 'Take-profit';

    // Robot arrêté ou en pause : aucun ordre ne part, y compris une sortie. On n'« enregistre » pas le déclenchement
    // (la sortie sera retentée dès que le robot repart) mais on prévient, une fois par jour.
    const status = await this.control.status(position.userId);
    if (!status.canTrade) {
      await this.notifyUser(
        position.userId,
        `exit-blocked:${position.id}:${now.toISOString().slice(0, 10)}`,
        {
          title: `${label} atteint, ordre non passé`,
          body: `${base} a atteint votre ${label.toLowerCase()} mais le robot est ${status.blockedReason === 'KILL_SWITCH' ? 'arrêté (kill switch)' : 'en pause (perte journalière maximale)'} : aucune vente n'a été passée.`,
          critical: true,
        },
      );
      return 'blocked';
    }

    // Prise atomique : une position ne déclenche qu'une seule sortie, même si deux passages se croisent.
    const claimed = await this.prisma.tradeLog.updateMany({
      where: { id: position.id, exitTriggeredAt: null },
      data: { exitTriggeredAt: now },
    });
    if (claimed.count !== 1) return 'skipped';

    // On ne vend jamais plus que ce qui est détenu (vente manuelle entre-temps).
    const held = (await this.portfolio.list(position.userId)).find(
      (h) => h.symbol === base,
    );
    const quantity = Prisma.Decimal.min(
      D(position.filledQuantity),
      held ? D(held.quantity) : D(0),
    );
    if (quantity.lte(0)) {
      await this.audit.log({
        userId: position.userId,
        action: 'order.exit_skipped',
        entityType: 'TradeLog',
        entityId: position.id,
        metadata: { reason: 'nothing_to_sell', origin },
      });
      return 'skipped';
    }

    await this.audit.log({
      userId: position.userId,
      action: 'order.exit_triggered',
      entityType: 'TradeLog',
      entityId: position.id,
      metadata: {
        origin,
        symbol: position.symbol,
        price: price.toFixed(),
        quantity: quantity.toFixed(),
      },
    });

    const order = await this.orders.submit(position.userId, {
      symbol: base,
      side: OrderSide.SELL,
      quantity,
      origin,
      parentOrderId: position.id,
    });
    if (order.status === OrderStatus.REJECTED) {
      const reason = order.failureReason as keyof typeof REJECTION_MESSAGES;
      await this.notifyUser(position.userId, `exit-rejected:${position.id}`, {
        title: `${label} atteint, vente refusée`,
        body: `La vente de ${base} a été refusée : ${REJECTION_MESSAGES[reason] ?? 'motif inconnu'}.`,
        critical: true,
      });
    }
    return 'triggered';
  }

  private async notifyUser(
    userId: string,
    dedupeKey: string,
    message: { title: string; body: string; critical: boolean },
  ): Promise<void> {
    try {
      await this.notifications.notify(userId, { ...message, dedupeKey });
    } catch (error) {
      this.logger.error(
        `Notification de sortie non envoyée : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
      );
    }
  }
}
