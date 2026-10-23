import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PortfolioService } from '../../portfolio/portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from '../../portfolio/price/price-provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { dailyLossBreached } from '../risk-rules.js';
import {
  lossPct,
  openHoldingsValueNow,
  toSnapshot,
  type OpenHolding,
} from './daily-loss.js';
import { localDateOf, nextLocalMidnight } from './local-day.js';

export type DailyLossOutcome =
  | 'skipped' // utilisateur introuvable ou désactivé
  | 'no_holdings' // rien à surveiller
  | 'no_prices' // un prix manque : on ne conclut pas sur un total partiel
  | 'baseline_created' // première observation du jour : l'instantané d'ouverture est enregistré
  | 'ok'
  | 'paused' // seuil atteint : robot mis en pause
  | 'already_paused';

/**
 * Surveillance de la perte journalière (SPEC module 2). Pour chaque utilisateur : enregistre la valeur d'ouverture
 * de sa journée locale, la compare à la valeur actuelle des mêmes positions et, si la perte atteint
 * `RiskSettings.maxDailyLossPct`, met le robot en pause jusqu'au prochain minuit local.
 */
@Injectable()
export class DailyLossMonitor {
  private readonly logger = new Logger(DailyLossMonitor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly prices: PriceProvider,
    private readonly audit: AuditService,
  ) {}

  async checkUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<DailyLossOutcome> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, timezone: true, botPausedUntil: true },
    });
    if (!user) return 'skipped';

    const holdings = await this.portfolio.list(userId);
    if (holdings.length === 0) return 'no_holdings';

    const localDate = localDateOf(now, user.timezone);
    const snapshot = await this.prisma.equitySnapshot.findUnique({
      where: { userId_localDate: { userId, localDate } },
    });
    const open = snapshot
      ? (snapshot.holdings as unknown as OpenHolding[])
      : [];

    // Prix des positions actuelles et de celles d'ouverture (une position vendue depuis reste à valoriser).
    const symbols = [
      ...new Set([
        ...holdings.map((h) => h.symbol),
        ...open.map((h) => h.symbol),
      ]),
    ];
    const prices = await this.getPrices(symbols);
    if (!prices) return 'no_prices';

    if (!snapshot) {
      const baseline = toSnapshot(holdings, prices);
      if (!baseline) return 'no_prices';
      await this.createSnapshot(userId, localDate, baseline);
      return 'baseline_created';
    }

    const current = openHoldingsValueNow(open, prices);
    if (!current) return 'no_prices';

    const openEquity = new Prisma.Decimal(snapshot.equity);
    const settings = await this.prisma.riskSettings.findUnique({
      where: { userId },
      select: { maxDailyLossPct: true },
    });
    if (
      !settings ||
      !dailyLossBreached(openEquity, current, settings.maxDailyLossPct)
    )
      return 'ok';

    if (user.botPausedUntil && user.botPausedUntil > now)
      return 'already_paused';

    const pausedUntil = nextLocalMidnight(now, user.timezone);
    await this.prisma.user.update({
      where: { id: userId },
      data: { botPausedUntil: pausedUntil },
    });
    await this.audit.log({
      userId,
      action: 'risk.daily_loss_paused',
      entityType: 'User',
      entityId: userId,
      metadata: {
        localDate,
        openEquity: openEquity.toFixed(),
        currentValue: current.toDecimalPlaces(8).toFixed(),
        lossPct: lossPct(openEquity, current).toFixed(),
        maxDailyLossPct: new Prisma.Decimal(settings.maxDailyLossPct).toFixed(),
        pausedUntil: pausedUntil.toISOString(),
      },
    });
    // TODO notifications (module 3) : alerte critique, qui doit passer même en Mode Nuit.
    this.logger.warn(
      `Perte journalière max atteinte (userId=${userId}) : robot en pause jusqu'au ${pausedUntil.toISOString()}`,
    );
    return 'paused';
  }

  /** Renvoie `null` si la source de prix est injoignable : l'appelant ne conclut pas. */
  private async getPrices(
    symbols: string[],
  ): Promise<Map<string, Prisma.Decimal | null> | null> {
    try {
      return await this.prices.getPrices(symbols);
    } catch (error) {
      if (error instanceof PriceUnavailableError) return null;
      throw error;
    }
  }

  /** Deux ticks simultanés peuvent créer le même instantané : la contrainte unique protège, le perdant l'ignore. */
  private async createSnapshot(
    userId: string,
    localDate: string,
    baseline: { equity: Prisma.Decimal; holdings: OpenHolding[] },
  ): Promise<void> {
    try {
      await this.prisma.equitySnapshot.create({
        data: {
          userId,
          localDate,
          equity: baseline.equity,
          holdings: baseline.holdings as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ))
        throw error;
    }
  }
}
