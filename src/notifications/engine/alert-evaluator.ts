import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AlertCondition,
  type NotificationChannel,
} from '../../generated/prisma/enums.js';
import { PortfolioService } from '../../portfolio/portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from '../../portfolio/price/price-provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationService } from '../notification.service.js';
import { conditionMet, type Observation } from './alert-conditions.js';
import { describeAlert } from './alert-messages.js';

/** Délai minimal entre deux déclenchements d'une même alerte : un prix qui oscille autour du seuil ne doit pas spammer. */
export const MIN_RETRIGGER_MS = 15 * 60_000;

export interface EvaluationSummary {
  evaluated: number;
  triggered: number;
  rearmed: number;
  /** Données manquantes (prix indisponible) : aucun changement d'état. */
  skipped: number;
  failed: number;
}

type AlertOutcome =
  'triggered' | 'rearmed' | 'unchanged' | 'debounced' | 'skipped';

interface ActiveAlert {
  id: string;
  userId: string;
  assetSymbol: string | null;
  condition: AlertCondition;
  threshold: Prisma.Decimal;
  windowMinutes: number | null;
  channel: NotificationChannel;
  isCritical: boolean;
  isTriggered: boolean;
  lastTriggeredAt: Date | null;
}

interface Holding {
  symbol: string;
  quantity: Prisma.Decimal;
}

/**
 * Évalue les alertes actives sur les prix (SPEC module 3). Une alerte notifie **au franchissement** : quand sa
 * condition devient vraie, puis reste silencieuse tant qu'elle est vraie ; elle se ré-arme quand la condition
 * redevient fausse. Une donnée manquante ne change jamais l'état (ni déclenchement, ni ré-armement).
 */
@Injectable()
export class AlertEvaluator {
  private readonly logger = new Logger(AlertEvaluator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly prices: PriceProvider,
    private readonly notifications: NotificationService,
  ) {}

  async run(now: Date = new Date()): Promise<EvaluationSummary> {
    const summary: EvaluationSummary = {
      evaluated: 0,
      triggered: 0,
      rearmed: 0,
      skipped: 0,
      failed: 0,
    };

    const alerts = (await this.prisma.alertConfig.findMany({
      where: { isActive: true, user: { deletedAt: null } },
      select: {
        id: true,
        userId: true,
        assetSymbol: true,
        condition: true,
        threshold: true,
        windowMinutes: true,
        channel: true,
        isCritical: true,
        isTriggered: true,
        lastTriggeredAt: true,
      },
    })) as ActiveAlert[];
    if (alerts.length === 0) return summary;

    // Portefeuilles des utilisateurs qui ont une alerte de portefeuille, lus une seule fois.
    const holdings = new Map<string, Holding[]>();
    for (const userId of new Set(
      alerts.filter(isPortfolioAlert).map((a) => a.userId),
    )) {
      holdings.set(
        userId,
        (await this.portfolio.list(userId)).map((h) => ({
          symbol: h.symbol,
          quantity: new Prisma.Decimal(h.quantity),
        })),
      );
    }

    const symbols = [
      ...new Set([
        ...alerts.flatMap((a) => (a.assetSymbol ? [a.assetSymbol] : [])),
        ...[...holdings.values()].flatMap((hs) => hs.map((h) => h.symbol)),
      ]),
    ];

    let current: Map<string, Prisma.Decimal | null>;
    try {
      current = await this.prices.getPrices(symbols);
    } catch (error) {
      if (!(error instanceof PriceUnavailableError)) throw error;
      summary.skipped = alerts.length;
      return summary;
    }

    // Prix passés partagés entre alertes d'un même (symbole, fenêtre) pendant ce passage.
    const pastCache = new Map<string, Promise<Prisma.Decimal | null>>();
    const pastPrice = (symbol: string, windowMinutes: number) => {
      const key = `${symbol}:${windowMinutes}`;
      let promise = pastCache.get(key);
      if (!promise) {
        promise = this.prices
          .getPriceAt(symbol, new Date(now.getTime() - windowMinutes * 60_000))
          .catch((error: unknown) => {
            if (error instanceof PriceUnavailableError) return null;
            throw error;
          });
        pastCache.set(key, promise);
      }
      return promise;
    };

    for (const alert of alerts) {
      // Une erreur sur une alerte ne doit pas empêcher l'évaluation des autres.
      try {
        const observed = await this.observe(
          alert,
          current,
          holdings,
          pastPrice,
        );
        const outcome = await this.apply(alert, observed, now);
        summary.evaluated++;
        if (outcome === 'triggered') summary.triggered++;
        else if (outcome === 'rearmed') summary.rearmed++;
        else if (outcome === 'skipped') summary.skipped++;
      } catch (error) {
        summary.failed++;
        // Nom de l'erreur seulement : un message d'erreur peut embarquer des données.
        this.logger.error(
          `Évaluation en échec (alerte ${alert.id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
      }
    }
    return summary;
  }

  /** Valeurs à comparer au seuil, ou `null` si une donnée manque. */
  private async observe(
    alert: ActiveAlert,
    current: Map<string, Prisma.Decimal | null>,
    holdings: Map<string, Holding[]>,
    pastPrice: (
      symbol: string,
      windowMinutes: number,
    ) => Promise<Prisma.Decimal | null>,
  ): Promise<{
    observation: Observation;
    current: Prisma.Decimal;
    past: Prisma.Decimal | null;
  } | null> {
    const windowMinutes = alert.windowMinutes;

    if (isPortfolioAlert(alert)) {
      const owned = holdings.get(alert.userId) ?? [];
      if (owned.length === 0 || windowMinutes === null) return null;

      let now = new Prisma.Decimal(0);
      let past = new Prisma.Decimal(0);
      for (const { symbol, quantity } of owned) {
        const price = current.get(symbol);
        const before = await pastPrice(symbol, windowMinutes);
        // Un prix manquant fausserait le total : on ne conclut pas.
        if (!price || !before) return null;
        now = now.plus(quantity.mul(price));
        past = past.plus(quantity.mul(before));
      }
      return { observation: { current: now, past }, current: now, past };
    }

    const price = alert.assetSymbol ? current.get(alert.assetSymbol) : null;
    if (!price) return null;
    const crossing =
      alert.condition === AlertCondition.PRICE_CROSS_ABOVE ||
      alert.condition === AlertCondition.PRICE_CROSS_BELOW;
    const past =
      crossing || windowMinutes === null
        ? null
        : await pastPrice(alert.assetSymbol!, windowMinutes);
    return { observation: { current: price, past }, current: price, past };
  }

  /** Applique la transition d'état (franchissement → notification, retour à la normale → ré-armement). */
  private async apply(
    alert: ActiveAlert,
    observed: Awaited<ReturnType<AlertEvaluator['observe']>>,
    now: Date,
  ): Promise<AlertOutcome> {
    const met = observed
      ? conditionMet(alert.condition, alert.threshold, observed.observation)
      : null;
    if (met === null || !observed) return 'skipped';

    if (!met) {
      if (!alert.isTriggered) return 'unchanged';
      await this.prisma.alertConfig.updateMany({
        where: { id: alert.id, isTriggered: true },
        data: { isTriggered: false },
      });
      return 'rearmed';
    }

    if (alert.isTriggered) return 'unchanged';
    if (
      alert.lastTriggeredAt &&
      now.getTime() - alert.lastTriggeredAt.getTime() < MIN_RETRIGGER_MS
    )
      return 'debounced';

    // Prise de l'état atomique : si deux évaluations se croisent, une seule notifie.
    const claimed = await this.prisma.alertConfig.updateMany({
      where: { id: alert.id, isTriggered: false },
      data: { isTriggered: true, lastTriggeredAt: now },
    });
    if (claimed.count !== 1) return 'unchanged';

    try {
      const { title, body } = describeAlert(
        { ...alert, threshold: new Prisma.Decimal(alert.threshold) },
        { current: observed.current, past: observed.past },
      );
      await this.notifications.notify(alert.userId, {
        title,
        body,
        critical: alert.isCritical,
        channel: alert.channel,
        dedupeKey: `alert:${alert.id}:${now.toISOString().slice(0, 16)}`,
      });
    } catch (error) {
      // L'envoi a échoué : on rend l'état pour retenter au prochain passage plutôt que de perdre l'alerte.
      await this.prisma.alertConfig.updateMany({
        where: { id: alert.id },
        data: { isTriggered: false, lastTriggeredAt: alert.lastTriggeredAt },
      });
      throw error;
    }
    return 'triggered';
  }
}

const isPortfolioAlert = (alert: ActiveAlert): boolean =>
  alert.condition === AlertCondition.PORTFOLIO_DROP_PCT;
