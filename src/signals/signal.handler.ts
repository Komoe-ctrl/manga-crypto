import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import {
  OrderOrigin,
  OrderSide,
  OrderStatus,
} from '../generated/prisma/enums.js';
import { STABLECOINS } from '../orders/order-rules.js';
import { OrdersService } from '../orders/orders.service.js';
import { DuplicateOrderError } from '../orders/orders.types.js';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from '../portfolio/price/price-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RiskSettingsService } from '../risk/risk-settings.service.js';
import { TradingControlService } from '../risk/trading-control.service.js';
import type { Signal } from './signal.schema.js';
import { sizeBuy, type SizingSkip } from './signal-sizing.js';

/** Réglages de traitement des signaux (variables d'environnement, valeurs par défaut de la SPEC section 7). */
export interface SignalSettings {
  /** Score minimal pour agir. */
  minScore: number;
  /** Au-delà, le signal est périmé et ignoré. */
  maxAgeMs: number;
  /** Un achat est ignoré si le prix a bougé de plus de ce pourcentage depuis l'analyse. */
  maxPriceDriftPct: number;
}

/** Ce qui est arrivé à un signal pour un utilisateur. */
export type SignalOutcome =
  | 'submitted' // ordre créé (il peut ensuite être refusé ou exécuté : voir l'ordre)
  | 'rejected' // ordre créé mais refusé par un garde-fou (enregistré avec son motif)
  | 'duplicate' // ce signal a déjà donné lieu à un ordre pour cet utilisateur
  | 'robot_blocked' // kill switch ou pause : aucun ordre
  | 'no_position' // vente demandée sans position
  | 'price_drift' // le prix a trop bougé depuis l'analyse
  | 'capital_unknown' // un prix manque : capital non calculable
  | 'price_unavailable' // source de prix injoignable : transitoire, à retenter
  | SizingSkip;

/** Ignoré pour tout le monde, avant de regarder le moindre utilisateur. */
export type SignalIgnored =
  'hold' | 'stale' | 'symbol_not_tradable' | 'below_min_score';

export interface SignalSummary {
  ignored: SignalIgnored | null;
  users: number;
  outcomes: Partial<Record<SignalOutcome, number>>;
  failed: number;
  /** Vrai si le signal doit être retenté (prix indisponible, erreur inattendue) : il reste en attente dans le stream. */
  retry: boolean;
}

const DEFAULTS: SignalSettings = {
  minScore: 0.6,
  maxAgeMs: 5 * 60_000,
  maxPriceDriftPct: 2,
};

/**
 * Transforme un signal valide en ordres (SPEC section 7). Le signal ne vise personne en particulier : chaque
 * utilisateur actif passe par les **mêmes garde-fous que tout autre ordre** (kill switch, pause, exposition maximale,
 * fonds, mode PAPER ou LIVE). Un signal ne contourne jamais `OrdersService.submit`.
 *
 * Idempotent par utilisateur : l'`id` du signal est enregistré sur l'ordre (`signalStreamId`), un signal retraité
 * (reprise après plantage, republication) ne repasse jamais d'ordre.
 */
@Injectable()
export class SignalHandler {
  private readonly logger = new Logger(SignalHandler.name);
  private readonly settings: SignalSettings;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly control: TradingControlService,
    private readonly portfolio: PortfolioService,
    private readonly valuation: PortfolioValuationService,
    private readonly prices: PriceProvider,
    private readonly riskSettings: RiskSettingsService,
    private readonly orders: OrdersService,
  ) {
    this.settings = {
      minScore: number(
        config.get('SIGNAL_MIN_SCORE'),
        DEFAULTS.minScore,
        (n) => n >= 0 && n <= 1,
      ),
      maxAgeMs:
        number(
          config.get('SIGNAL_MAX_AGE_SECONDS'),
          DEFAULTS.maxAgeMs / 1000,
          (n) => n > 0,
        ) * 1000,
      maxPriceDriftPct: number(
        config.get('SIGNAL_MAX_PRICE_DRIFT_PCT'),
        DEFAULTS.maxPriceDriftPct,
        (n) => n > 0,
      ),
    };
  }

  async handle(
    signal: Signal,
    streamEntryId: string,
    now: Date = new Date(),
  ): Promise<SignalSummary> {
    const ignored = this.ignoredFor(signal, now);
    if (ignored) {
      this.logger.log(
        `Signal ${signal.id} (${signal.action} ${signal.symbol}) ignoré : ${ignored}`,
      );
      return { ignored, users: 0, outcomes: {}, failed: 0, retry: false };
    }

    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    const summary: SignalSummary = {
      ignored: null,
      users: users.length,
      outcomes: {},
      failed: 0,
      retry: false,
    };

    for (const { id } of users) {
      // Une erreur chez un utilisateur ne doit pas empêcher les autres : on retentera le signal (les utilisateurs déjà
      // servis sont protégés par la déduplication).
      try {
        const outcome = await this.forUser(id, signal, streamEntryId);
        summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
        if (outcome === 'price_unavailable') summary.retry = true;
      } catch (error) {
        summary.failed++;
        summary.retry = true;
        // Nom de l'erreur seulement : un message d'erreur peut embarquer des données.
        this.logger.error(
          `Signal ${signal.id} en échec (userId=${id}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
        );
      }
    }

    this.logger.log(
      `Signal ${signal.id} (${signal.action} ${signal.symbol}, score ${signal.score}) : ${JSON.stringify(summary.outcomes)}`,
    );
    return summary;
  }

  private ignoredFor(signal: Signal, now: Date): SignalIgnored | null {
    if (signal.action === 'HOLD') return 'hold';
    if (now.getTime() - signal.ts.getTime() > this.settings.maxAgeMs)
      return 'stale';
    if (STABLECOINS.has(signal.symbol)) return 'symbol_not_tradable';
    if (signal.score < this.settings.minScore) return 'below_min_score';
    return null;
  }

  private async forUser(
    userId: string,
    signal: Signal,
    streamEntryId: string,
  ): Promise<SignalOutcome> {
    const done = await this.prisma.tradeLog.findFirst({
      where: { userId, signalStreamId: signal.id },
      select: { id: true },
    });
    if (done) return 'duplicate';

    // Un signal n'est pas une intention de l'utilisateur : quand le robot est arrêté ou en pause, on n'enregistre
    // pas d'ordre refusé pour chaque signal (ce serait du bruit) ; le signal est simplement ignoré.
    if (!(await this.control.status(userId)).canTrade) return 'robot_blocked';

    const price = await this.currentPrice(signal.symbol);
    if (!price) return 'price_unavailable';

    const held = new Map(
      (await this.portfolio.list(userId)).map((h) => [
        h.symbol,
        new Prisma.Decimal(h.quantity),
      ]),
    ).get(signal.symbol);
    const heldQuantity = held ?? new Prisma.Decimal(0);

    if (signal.action === 'SELL') {
      // Vente : toute la position détenue de ce symbole.
      if (heldQuantity.lte(0)) return 'no_position';
      return this.submit(
        userId,
        OrderSide.SELL,
        heldQuantity,
        signal,
        streamEntryId,
      );
    }

    // Achat : on ne court pas après un prix qui a déjà bougé depuis l'analyse.
    if (
      signal.price &&
      this.drift(price, signal.price).gt(this.settings.maxPriceDriftPct)
    )
      return 'price_drift';

    const capital = await this.valuation.totalValue(userId);
    if (!capital) return 'capital_unknown';

    const sizing = sizeBuy({
      score: signal.score,
      minScore: this.settings.minScore,
      price,
      capital,
      maxExposurePct: (await this.riskSettings.get(userId)).maxExposurePct,
      heldQuantity,
    });
    if ('skip' in sizing) return sizing.skip;
    return this.submit(
      userId,
      OrderSide.BUY,
      sizing.quantity,
      signal,
      streamEntryId,
    );
  }

  private async submit(
    userId: string,
    side: OrderSide,
    quantity: Prisma.Decimal,
    signal: Signal,
    streamEntryId: string,
  ): Promise<SignalOutcome> {
    try {
      const order = await this.orders.submit(userId, {
        symbol: signal.symbol,
        side,
        quantity,
        origin: OrderOrigin.SIGNAL,
        // L'identifiant du signal (unique par utilisateur en base) sert à la déduplication ; l'entrée du stream est
        // gardée dans le contenu.
        signalStreamId: signal.id,
        signalPayload: {
          v: signal.v,
          id: signal.id,
          ts: signal.ts.toISOString(),
          symbol: signal.symbol,
          action: signal.action,
          score: signal.score,
          price: signal.price,
          reason: signal.reason,
          indicators: signal.indicators,
          streamEntryId,
        },
      });
      return order.status === OrderStatus.REJECTED ? 'rejected' : 'submitted';
    } catch (error) {
      // Traitement simultané du même signal : l'autre a gagné la contrainte unique, aucun ordre n'est doublé.
      if (error instanceof DuplicateOrderError) return 'duplicate';
      throw error;
    }
  }

  /** Écart du prix courant au prix du signal, en %. */
  private drift(current: Prisma.Decimal, signalPrice: string): Prisma.Decimal {
    const reference = new Prisma.Decimal(signalPrice);
    return current.minus(reference).abs().div(reference).mul(100);
  }

  private async currentPrice(symbol: string): Promise<Prisma.Decimal | null> {
    try {
      return (await this.prices.getPrices([symbol])).get(symbol) ?? null;
    } catch (error) {
      if (error instanceof PriceUnavailableError) return null;
      throw error;
    }
  }
}

/** Lit un réglage numérique de l'environnement ; une valeur absente ou hors limites donne la valeur par défaut. */
function number(
  raw: unknown,
  fallback: number,
  valid: (n: number) => boolean,
): number {
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && valid(value) ? value : fallback;
}
