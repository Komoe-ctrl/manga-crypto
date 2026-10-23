import { Injectable, Logger } from '@nestjs/common';
import {
  localDateOf,
  localMinuteOf,
  localWeekday,
  startOfLocalDay,
} from '../common/local-day.js';
import { Prisma } from '../generated/prisma/client.js';
import { DigestPeriod, NotificationStatus } from '../generated/prisma/enums.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from '../portfolio/price/price-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildDigest,
  type DigestInput,
  type DigestKind,
} from './digest-content.js';

/** Rattrapage : au-delà de 6 h après l'heure du rapport, la journée est abandonnée (un rapport « du matin » le soir serait trompeur). */
export const CATCHUP_MINUTES = 360;
/** Pendant la première heure, des prix indisponibles font attendre le tour suivant ; ensuite on génère sans les chiffres. */
export const PRICE_RETRY_MINUTES = 60;

const DAY_MS = 24 * 3_600_000;
const MONDAY = 1;

export type DigestOutcome =
  | 'skipped' // utilisateur introuvable ou désactivé
  | 'disabled' // rapport désactivé dans les réglages
  | 'not_due' // pas dans la fenêtre horaire du rapport
  | 'waiting_for_prices'
  | 'already_generated'
  | 'generated';

export interface DigestRunSummary {
  checked: number;
  generated: number;
  failed: number;
}

type KindOutcome = 'generated' | 'exists' | 'waiting';

interface Collected {
  input: Omit<DigestInput, 'kind'>;
  held: { id: string }[];
}

/**
 * Rapport du matin (SPEC module 3). À l'heure choisie par l'utilisateur (fuseau local), génère la synthèse de la
 * nuit : évolution du portefeuille, alertes critiques, alertes non urgentes mises en attente par le Mode Nuit.
 * Un rapport `TODAY` par jour local ; un rapport `WEEK` en plus le lundi. Idempotent (contrainte unique).
 */
@Injectable()
export class DigestGenerator {
  private readonly logger = new Logger(DigestGenerator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly prices: PriceProvider,
    private readonly notifications: NotificationService,
  ) {}

  async run(now: Date = new Date()): Promise<DigestRunSummary> {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    const summary: DigestRunSummary = { checked: 0, generated: 0, failed: 0 };

    for (const { id } of users) {
      // Une erreur chez un utilisateur ne doit pas empêcher les rapports des autres.
      try {
        if ((await this.checkUser(id, now)) === 'generated')
          summary.generated++;
        summary.checked++;
      } catch (error) {
        summary.failed++;
        // Nom de l'erreur seulement : un message d'erreur peut embarquer des données.
        this.logger.error(
          `Rapport en échec (userId=${id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
      }
    }
    return summary;
  }

  async checkUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<DigestOutcome> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!user) return 'skipped';

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { userId },
      select: { digestEnabled: true, digestMinute: true },
    });
    if (!settings?.digestEnabled) return 'disabled';

    const sinceDue = localMinuteOf(now, user.timezone) - settings.digestMinute;
    if (sinceDue < 0 || sinceDue >= CATCHUP_MINUTES) return 'not_due';

    const dayStart = startOfLocalDay(now, user.timezone);
    const mustWaitForPrices = sinceDue < PRICE_RETRY_MINUTES;
    const localDate = localDateOf(now, user.timezone);

    const kinds: DigestKind[] =
      localWeekday(now, user.timezone) === MONDAY
        ? ['TODAY', 'WEEK']
        : ['TODAY'];
    const outcomes: KindOutcome[] = [];
    for (const kind of kinds) {
      outcomes.push(
        await this.ensure(
          userId,
          kind,
          dayStart,
          localDate,
          now,
          mustWaitForPrices,
        ),
      );
    }

    if (outcomes.includes('generated')) return 'generated';
    return outcomes.includes('waiting')
      ? 'waiting_for_prices'
      : 'already_generated';
  }

  private async ensure(
    userId: string,
    kind: DigestKind,
    dayStart: Date,
    localDate: string,
    now: Date,
    mustWaitForPrices: boolean,
  ): Promise<KindOutcome> {
    const period = kind === 'TODAY' ? DigestPeriod.TODAY : DigestPeriod.WEEK;
    const existing = await this.prisma.digestReport.findFirst({
      where: { userId, period, periodStart: dayStart },
      select: { id: true },
    });
    if (existing) return 'exists';

    const collected = await this.collect(userId, kind, now, mustWaitForPrices);
    if (!collected) return 'waiting';

    const content = buildDigest({ kind, ...collected.input });
    const report = await this.createReport(
      userId,
      period,
      dayStart,
      now,
      content,
      collected.held.length,
    );
    if (!report) return 'exists'; // un autre passage l'a créé entre-temps

    if (collected.held.length > 0) {
      // Seules les notifications lues au début de ce passage sont marquées : une arrivée entre-temps reste en attente.
      await this.prisma.notification.updateMany({
        where: {
          id: { in: collected.held.map((h) => h.id) },
          status: NotificationStatus.HELD,
        },
        data: { status: NotificationStatus.DIGESTED, digestId: report.id },
      });
    }
    await this.announce(userId, kind, localDate, content);
    return 'generated';
  }

  /**
   * Rassemble les données du rapport. `null` : il faut attendre (prix indisponibles dans la première heure) ;
   * passé ce délai, le rapport est généré sans les chiffres du portefeuille plutôt que pas du tout.
   */
  private async collect(
    userId: string,
    kind: DigestKind,
    now: Date,
    mustWaitForPrices: boolean,
  ): Promise<Collected | null> {
    const windowMs = kind === 'TODAY' ? DAY_MS : 7 * DAY_MS;
    const windowStart = new Date(now.getTime() - windowMs);

    const holdings = (await this.portfolio.list(userId)).map((h) => ({
      symbol: h.symbol,
      quantity: new Prisma.Decimal(h.quantity),
    }));

    let portfolio: DigestInput['portfolio'] = null;
    let movers: DigestInput['movers'] = [];
    if (holdings.length > 0) {
      const market = await this.market(
        holdings.map((h) => h.symbol),
        windowStart,
      );
      if (!market && mustWaitForPrices) return null;

      portfolio = { valueNow: null, valuePast: null };
      if (market) {
        let valueNow: Prisma.Decimal | null = new Prisma.Decimal(0);
        let valuePast: Prisma.Decimal | null = new Prisma.Decimal(0);
        for (const { symbol, quantity } of holdings) {
          const price = market.now.get(symbol) ?? null;
          const before = market.past.get(symbol) ?? null;
          valueNow =
            price && valueNow ? valueNow.plus(quantity.mul(price)) : null;
          valuePast =
            before && valuePast ? valuePast.plus(quantity.mul(before)) : null;
          if (price && before && before.gt(0)) {
            movers.push({
              symbol,
              changePct: price.minus(before).div(before).mul(100),
            });
          }
        }
        portfolio = { valueNow, valuePast };
      }
    }

    // Les notifications en attente sont reprises par le rapport du jour, pas par celui de la semaine (double compte).
    const held =
      kind === 'TODAY'
        ? await this.prisma.notification.findMany({
            where: { userId, status: NotificationStatus.HELD },
            orderBy: { createdAt: 'asc' },
            select: { id: true, title: true },
          })
        : [];
    const critical = await this.prisma.notification.findMany({
      where: { userId, critical: true, createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'asc' },
      select: { title: true },
    });

    return {
      held: held.map((h) => ({ id: h.id })),
      input: {
        held: held.map((h) => h.title),
        critical: critical.map((c) => c.title),
        portfolio,
        movers,
      },
    };
  }

  /** Prix courants et prix du début de période ; `null` si la source est injoignable. */
  private async market(symbols: string[], at: Date) {
    try {
      const [now, pastEntries] = await Promise.all([
        this.prices.getPrices(symbols),
        Promise.all(
          symbols.map(
            async (s) => [s, await this.prices.getPriceAt(s, at)] as const,
          ),
        ),
      ]);
      return { now, past: new Map(pastEntries) };
    } catch (error) {
      if (error instanceof PriceUnavailableError) return null;
      throw error;
    }
  }

  /** Renvoie `null` si le rapport existe déjà (création simultanée départagée par la contrainte unique). */
  private async createReport(
    userId: string,
    period: DigestPeriod,
    periodStart: Date,
    periodEnd: Date,
    content: ReturnType<typeof buildDigest>,
    queuedAlertsCount: number,
  ): Promise<{ id: string } | null> {
    try {
      return await this.prisma.digestReport.create({
        data: {
          userId,
          period,
          periodStart,
          periodEnd,
          summary: content.summary,
          points: content.points,
          portfolioDeltaPct: content.portfolioDeltaPct,
          queuedAlertsCount,
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return null;
      throw error;
    }
  }

  /**
   * Envoie le rapport comme notification immédiate (hors Mode Nuit : c'est le but du rapport). Le rapport est déjà
   * enregistré : un échec d'envoi est journalisé (nom seulement) et ne le défait jamais.
   */
  private async announce(
    userId: string,
    kind: DigestKind,
    localDate: string,
    content: ReturnType<typeof buildDigest>,
  ): Promise<void> {
    try {
      await this.notifications.notify(userId, {
        title: kind === 'TODAY' ? 'Rapport du matin' : 'Rapport de la semaine',
        body: [content.summary, ...content.points.map((p) => `• ${p}`)].join(
          '\n',
        ),
        immediate: true,
        dedupeKey: `digest:${kind}:${localDate}`,
      });
    } catch (error) {
      this.logger.error(
        `Rapport non envoyé (userId=${userId}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
      );
    }
  }
}
