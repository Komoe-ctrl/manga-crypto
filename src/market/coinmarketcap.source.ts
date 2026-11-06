import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import {
  finiteDecimal,
  MarketSource,
  positiveDecimal,
  type MarketCoin,
} from './market-source.js';

const URL = 'https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest';
const TIMEOUT_MS = 10_000;

interface QuoteEntry {
  name?: unknown;
  symbol?: unknown;
  cmc_rank?: unknown;
  quote?: {
    USD?: {
      price?: unknown;
      market_cap?: unknown;
      percent_change_24h?: unknown;
    };
  };
}

/**
 * CoinMarketCap (`quotes/latest`, clé obligatoire, offre gratuite « Basic » suffisante). L'historique est réservé aux
 * offres payantes : cette source ne fournit que le prix du moment et les données de marché.
 */
export class CoinMarketCapSource extends MarketSource {
  readonly name = 'coinmarketcap';

  constructor(private readonly apiKey: string) {
    super();
  }

  protected async fetchCoins(
    symbols: string[],
  ): Promise<Map<string, MarketCoin>> {
    const query = new URLSearchParams({
      symbol: symbols.join(','),
      convert: 'USD',
      // Sans cela, un seul symbole inconnu fait échouer toute la requête.
      skip_invalid: 'true',
    });

    let response: Response;
    try {
      response = await fetch(`${URL}?${query}`, {
        headers: {
          'X-CMC_PRO_API_KEY': this.apiKey,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PriceUnavailableError();
    }
    // 429 : quota ; 401/403 : clé refusée. Une indisponibilité, jamais « l'actif n'existe pas ».
    if (!response.ok) throw new PriceUnavailableError();

    const body: unknown = await response.json().catch(() => null);
    const data = (body as { data?: unknown } | null)?.data;
    if (typeof data !== 'object' || data === null)
      throw new PriceUnavailableError();

    const coins = new Map<string, MarketCoin>();
    for (const [symbol, value] of Object.entries(data)) {
      const entries = Array.isArray(value) ? (value as QuoteEntry[]) : [];
      // Plusieurs actifs peuvent porter le même symbole : celui de meilleur rang est le vrai.
      const ranked = entries
        .map((entry) => ({ entry, usd: entry.quote?.USD }))
        .filter(({ usd }) => positiveDecimal(usd?.price) !== null)
        .sort((a, b) => rankOf(a.entry.cmc_rank) - rankOf(b.entry.cmc_rank))[0];
      if (!ranked) continue;

      const { entry, usd } = ranked;
      const key = symbol.toUpperCase();
      coins.set(key, {
        symbol: key,
        name: typeof entry.name === 'string' ? entry.name : key,
        priceUsd: positiveDecimal(usd?.price)!,
        marketCapUsd: positiveDecimal(usd?.market_cap),
        rank: typeof entry.cmc_rank === 'number' ? entry.cmc_rank : null,
        change24hPct: finiteDecimal(usd?.percent_change_24h),
      });
    }
    return coins;
  }
}

/** Un actif sans rang passe après tous les actifs classés. */
const rankOf = (rank: unknown): number =>
  typeof rank === 'number' ? rank : Number.POSITIVE_INFINITY;
