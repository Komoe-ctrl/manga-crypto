import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PriceProvider, PriceUnavailableError } from './price-provider.js';

const URL = 'https://api.binance.com/api/v3/ticker/price';
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
