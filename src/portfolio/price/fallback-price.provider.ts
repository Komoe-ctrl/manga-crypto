import { Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { MarketSource } from '../../market/market-source.js';
import { PriceProvider, PriceUnavailableError } from './price-provider.js';

/** Adapte une source de données de marché à l'interface de prix de la valorisation. */
export class MarketSourcePriceProvider extends PriceProvider {
  constructor(private readonly source: MarketSource) {
    super();
  }

  get name(): string {
    return this.source.name;
  }

  async getPrices(
    symbols: string[],
  ): Promise<Map<string, Prisma.Decimal | null>> {
    const coins = await this.source.coins(symbols);
    return new Map(
      symbols.map((symbol) => [symbol, coins.get(symbol)?.priceUsd ?? null]),
    );
  }

  getPriceAt(symbol: string, at: Date): Promise<Prisma.Decimal | null> {
    return this.source.priceAt(symbol, at);
  }

  getHourlyCloses(
    symbol: string,
    hours: number,
  ): Promise<Prisma.Decimal[] | null> {
    return this.source.hourlyCloses(symbol, hours);
  }
}

/**
 * Essaie les sources dans l'ordre (Binance, puis CoinGecko, puis CoinMarketCap) : une panne ou une limite de débit
 * d'une source ne prive pas le portefeuille de ses prix. Une source qui répond « actif inconnu » (`null`) laisse
 * la suivante tenter sa chance.
 *
 * Contrepartie assumée : deux sources n'affichent pas exactement le même prix (écart de quelques dixièmes de %),
 * et une courbe ne mélange jamais deux sources, puisqu'elle vient d'un seul appel.
 */
export class FallbackPriceProvider extends PriceProvider {
  private readonly logger = new Logger(FallbackPriceProvider.name);

  constructor(private readonly providers: PriceProvider[]) {
    super();
  }

  async getPrices(
    symbols: string[],
  ): Promise<Map<string, Prisma.Decimal | null>> {
    const result = new Map<string, Prisma.Decimal | null>(
      symbols.map((symbol) => [symbol, null]),
    );
    let pending = symbols;
    let answered = false;

    for (const provider of this.providers) {
      if (pending.length === 0) break;
      try {
        const prices = await provider.getPrices(pending);
        answered = true;
        for (const symbol of pending) {
          const price = prices.get(symbol) ?? null;
          if (price) result.set(symbol, price);
        }
        pending = pending.filter((symbol) => result.get(symbol) === null);
      } catch (error) {
        this.skip(provider, error);
      }
    }

    if (!answered) throw new PriceUnavailableError();
    return result;
  }

  getPriceAt(symbol: string, at: Date): Promise<Prisma.Decimal | null> {
    return this.firstAnswer((provider) => provider.getPriceAt(symbol, at));
  }

  getHourlyCloses(
    symbol: string,
    hours: number,
  ): Promise<Prisma.Decimal[] | null> {
    return this.firstAnswer((provider) =>
      provider.getHourlyCloses(symbol, hours),
    );
  }

  /** Première réponse non nulle ; `null` si au moins une source a répondu « inconnu » ; erreur si aucune n'a répondu. */
  private async firstAnswer<T>(
    ask: (provider: PriceProvider) => Promise<T | null>,
  ): Promise<T | null> {
    let answered = false;
    for (const provider of this.providers) {
      try {
        const value = await ask(provider);
        answered = true;
        if (value !== null) return value;
      } catch (error) {
        this.skip(provider, error);
      }
    }
    if (!answered) throw new PriceUnavailableError();
    return null;
  }

  private skip(provider: PriceProvider, error: unknown): void {
    if (!(error instanceof PriceUnavailableError)) throw error;
    // Message seulement : jamais l'objet d'erreur ni une URL qui pourrait porter une clé.
    this.logger.warn(
      `Source de prix « ${(provider as { name?: string }).name ?? provider.constructor.name} » indisponible : ${error.message}`,
    );
  }
}
