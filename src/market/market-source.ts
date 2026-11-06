import { Prisma } from '../generated/prisma/client.js';
import { PriceUnavailableError } from '../portfolio/price/price-provider.js';

/** Photo d'un actif chez un agrégateur de données de marché (CoinGecko, CoinMarketCap). Montants en USD. */
export interface MarketCoin {
  symbol: string;
  name: string;
  priceUsd: Prisma.Decimal;
  marketCapUsd: Prisma.Decimal | null;
  /** Rang par capitalisation (1 = bitcoin). */
  rank: number | null;
  change24hPct: Prisma.Decimal | null;
}

/** Jeton d'injection : sources de données de marché disponibles, par ordre de préférence. */
export const MARKET_SOURCES = Symbol('MARKET_SOURCES');

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

/**
 * Source de données de marché sans trading ni clé d'utilisateur. Les offres gratuites limitent le débit (quelques
 * dizaines d'appels par minute) : chaque actif est gardé 60 s, absence comprise, et seuls les symboles absents du
 * cache sont demandés.
 */
export abstract class MarketSource {
  abstract readonly name: 'coingecko' | 'coinmarketcap';

  private readonly cache = new Map<
    string,
    { coin: MarketCoin | null; expires: number }
  >();

  /** Symboles inconnus de la source : absents du résultat. @throws PriceUnavailableError si injoignable ou limitée. */
  async coins(symbols: string[]): Promise<Map<string, MarketCoin>> {
    const now = Date.now();
    const missing = symbols.filter((symbol) => {
      const hit = this.cache.get(symbol);
      return !hit || hit.expires <= now;
    });

    if (missing.length > 0) {
      const fetched = await this.fetchCoins(missing);
      if (this.cache.size + missing.length > CACHE_MAX_ENTRIES)
        this.cache.clear();
      for (const symbol of missing)
        this.cache.set(symbol, {
          coin: fetched.get(symbol) ?? null,
          expires: now + CACHE_TTL_MS,
        });
    }

    const result = new Map<string, MarketCoin>();
    for (const symbol of symbols) {
      const coin = this.cache.get(symbol)?.coin;
      if (coin) result.set(symbol, coin);
    }
    return result;
  }

  /**
   * Clôtures horaires des `hours` dernières heures, du plus ancien au plus récent. `null` : actif inconnu.
   * Par défaut, la source ne propose pas d'historique (CoinMarketCap : réservé aux offres payantes).
   */
  hourlyCloses(
    _symbol: string,
    _hours: number,
  ): Promise<Prisma.Decimal[] | null> {
    return Promise.reject(
      new PriceUnavailableError(`${this.name} : pas d'historique`),
    );
  }

  /** Prix à un instant passé. `null` : pas de donnée à cette date. Même réserve que `hourlyCloses`. */
  priceAt(_symbol: string, _at: Date): Promise<Prisma.Decimal | null> {
    return Promise.reject(
      new PriceUnavailableError(`${this.name} : pas d'historique`),
    );
  }

  protected abstract fetchCoins(
    symbols: string[],
  ): Promise<Map<string, MarketCoin>>;
}

/** Nombre fini strictement positif lu dans du JSON, sinon `null`. Passe par le texte : pas d'erreur d'arrondi. */
export function positiveDecimal(value: unknown): Prisma.Decimal | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Prisma.Decimal(String(value))
    : null;
}

/** Nombre fini (négatif admis : une variation), sinon `null`. */
export function finiteDecimal(value: unknown): Prisma.Decimal | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Prisma.Decimal(String(value))
    : null;
}
