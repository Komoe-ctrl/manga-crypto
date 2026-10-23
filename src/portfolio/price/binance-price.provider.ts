import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PriceProvider, PriceUnavailableError } from './price-provider.js';

const URL = 'https://api.binance.com/api/v3/ticker/price';
const KLINES_URL = 'https://api.binance.com/api/v3/klines';
/** Code d'erreur Binance : paire inconnue. */
const INVALID_SYMBOL = -1121;
/** Au-delà de 5 minutes d'écart, la bougie renvoyée n'est pas celle de la date demandée. */
const MAX_CANDLE_GAP_MS = 5 * 60_000;
const HISTORY_TTL_MS = 5 * 60_000;
const HISTORY_MAX_ENTRIES = 500;
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15_000;
/** Stablecoins valorisés à 1 USD (approximation assumée, voir docs/DECISIONS.md). */
const STABLECOINS = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'DAI']);

type Tickers = Map<string, Prisma.Decimal>;

/**
 * Prix publics Binance (`/api/v3/ticker/price`, sans clé) : une paire `<SYMBOLE>USDT` par actif.
 * Un seul appel récupère toutes les paires ; le résultat est mis en cache 15 s et les appels simultanés
 * partagent la même requête. Remplaçable par une lecture du cache Redis (SPEC, section D).
 */
@Injectable()
export class BinancePriceProvider extends PriceProvider {
  private cache: { at: number; tickers: Tickers } | null = null;
  private inFlight: Promise<Tickers> | null = null;
  private readonly history = new Map<
    string,
    { price: Prisma.Decimal | null; expires: number }
  >();

  async getPrices(
    symbols: string[],
  ): Promise<Map<string, Prisma.Decimal | null>> {
    const needsTickers = symbols.some((symbol) => !STABLECOINS.has(symbol));
    const tickers = needsTickers
      ? await this.tickers()
      : new Map<string, Prisma.Decimal>();

    return new Map(
      symbols.map((symbol) => [
        symbol,
        STABLECOINS.has(symbol)
          ? new Prisma.Decimal(1)
          : (tickers.get(`${symbol}USDT`) ?? null),
      ]),
    );
  }

  /**
   * Prix à un instant passé : ouverture de la bougie d'une minute de la paire `<SYMBOLE>USDT`
   * (`/api/v3/klines`, public, sans clé). L'instant est arrondi à la minute, ce qui permet de mettre le résultat
   * en cache. `null` si la paire n'existe pas ou n'était pas encore cotée à cette date.
   */
  async getPriceAt(symbol: string, at: Date): Promise<Prisma.Decimal | null> {
    if (STABLECOINS.has(symbol)) return new Prisma.Decimal(1);

    const minute = Math.floor(at.getTime() / 60_000) * 60_000;
    const key = `${symbol}:${minute}`;
    const cached = this.history.get(key);
    if (cached && cached.expires > Date.now()) return cached.price;

    const price = await this.fetchPriceAt(symbol, minute);
    this.remember(key, price);
    return price;
  }

  private async fetchPriceAt(
    symbol: string,
    minute: number,
  ): Promise<Prisma.Decimal | null> {
    let response: Response;
    try {
      response = await fetch(
        `${KLINES_URL}?symbol=${encodeURIComponent(symbol)}USDT&interval=1m&startTime=${minute}&limit=1`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
    } catch {
      throw new PriceUnavailableError();
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // -1121 : paire inconnue de Binance. Ce n'est pas une panne : il n'y a simplement pas de prix.
      if ((body as { code?: number } | null)?.code === INVALID_SYMBOL)
        return null;
      throw new PriceUnavailableError();
    }
    if (!Array.isArray(body)) throw new PriceUnavailableError();

    const candle: unknown = body[0];
    if (
      !Array.isArray(candle) ||
      typeof candle[0] !== 'number' ||
      typeof candle[1] !== 'string'
    ) {
      return null;
    }
    // Binance renvoie la première bougie *après* startTime : si elle est bien plus tardive, l'actif n'était
    // pas encore coté à la date demandée, et son premier prix n'est pas celui de cette date.
    if (candle[0] - minute > MAX_CANDLE_GAP_MS) return null;
    return Number(candle[1]) > 0 ? new Prisma.Decimal(candle[1]) : null;
  }

  private remember(key: string, price: Prisma.Decimal | null): void {
    if (this.history.size >= HISTORY_MAX_ENTRIES) {
      const now = Date.now();
      for (const [k, v] of this.history)
        if (v.expires <= now) this.history.delete(k);
      // Toujours plein : on retire la plus ancienne entrée (l'ordre d'insertion d'une Map est conservé).
      if (this.history.size >= HISTORY_MAX_ENTRIES) {
        this.history.delete(this.history.keys().next().value!);
      }
    }
    this.history.set(key, { price, expires: Date.now() + HISTORY_TTL_MS });
  }

  private tickers(): Promise<Tickers> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS)
      return Promise.resolve(this.cache.tickers);
    this.inFlight ??= this.fetchTickers().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchTickers(): Promise<Tickers> {
    let body: unknown;
    try {
      const response = await fetch(URL, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new PriceUnavailableError();
      body = await response.json();
    } catch {
      throw new PriceUnavailableError();
    }
    if (!Array.isArray(body)) throw new PriceUnavailableError();

    const tickers: Tickers = new Map();
    for (const entry of body as { symbol?: unknown; price?: unknown }[]) {
      if (typeof entry.symbol !== 'string' || typeof entry.price !== 'string')
        continue;
      const price =
        Number(entry.price) > 0 ? new Prisma.Decimal(entry.price) : null;
      if (price) tickers.set(entry.symbol, price);
    }
    this.cache = { at: Date.now(), tickers };
    return tickers;
  }
}
