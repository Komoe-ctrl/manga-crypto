import { Prisma } from '../generated/prisma/client.js';
import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import {
  finiteDecimal,
  MarketSource,
  positiveDecimal,
  type MarketCoin,
} from './market-source.js';

const TIMEOUT_MS = 10_000;
const MAX_SERIES_HOURS = 168;
/** Au-delà d'une heure d'écart, le point le plus proche n'est pas celui de la date demandée. */
const MAX_POINT_GAP_MS = 60 * 60_000;
const IDS_TTL_MS = 60 * 60_000;

export interface CoinGeckoConfig {
  /** Clé de l'offre Demo (gratuite) ou Pro ; sans clé, l'API publique, plus limitée. */
  apiKey?: string;
  pro?: boolean;
}

interface MarketRow {
  id?: unknown;
  symbol?: unknown;
  name?: unknown;
  current_price?: unknown;
  market_cap?: unknown;
  market_cap_rank?: unknown;
  price_change_percentage_24h?: unknown;
}

/**
 * CoinGecko. `/coins/markets?symbols=` répond par symbole, classé par capitalisation : en cas de symboles
 * homonymes, le premier est le vrai. L'historique passe par l'identifiant CoinGecko (`bitcoin`), appris au passage.
 */
export class CoinGeckoSource extends MarketSource {
  readonly name = 'coingecko';
  private readonly ids = new Map<string, { id: string; expires: number }>();

  constructor(private readonly config: CoinGeckoConfig = {}) {
    super();
  }

  protected async fetchCoins(
    symbols: string[],
  ): Promise<Map<string, MarketCoin>> {
    const query = new URLSearchParams({
      vs_currency: 'usd',
      symbols: symbols.map((s) => s.toLowerCase()).join(','),
      order: 'market_cap_desc',
      per_page: '250',
    });
    const body = await this.get(`/coins/markets?${query}`);
    if (!Array.isArray(body)) throw new PriceUnavailableError();

    const coins = new Map<string, MarketCoin>();
    for (const row of body as MarketRow[]) {
      if (typeof row.symbol !== 'string') continue;
      const symbol = row.symbol.toUpperCase();
      if (coins.has(symbol)) continue; // homonyme moins capitalisé
      if (typeof row.id === 'string')
        this.ids.set(symbol, { id: row.id, expires: Date.now() + IDS_TTL_MS });
      const priceUsd = positiveDecimal(row.current_price);
      if (!priceUsd) continue;
      coins.set(symbol, {
        symbol,
        name: typeof row.name === 'string' ? row.name : symbol,
        priceUsd,
        marketCapUsd: positiveDecimal(row.market_cap),
        rank:
          typeof row.market_cap_rank === 'number' ? row.market_cap_rank : null,
        change24hPct: finiteDecimal(row.price_change_percentage_24h),
      });
    }
    return coins;
  }

  override async hourlyCloses(
    symbol: string,
    hours: number,
  ): Promise<Prisma.Decimal[] | null> {
    const id = await this.idOf(symbol);
    if (!id) return null;
    const count = Math.min(Math.max(Math.trunc(hours), 1), MAX_SERIES_HOURS);
    // De 2 à 90 jours, CoinGecko renvoie un point par heure (moins : un point toutes les 5 minutes).
    const days = Math.max(2, Math.ceil(count / 24));
    const body = await this.get(
      `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`,
    );
    const points = pricePoints(body);
    const closes = points.map(([, price]) => price).slice(-count);
    return closes.length > 0 ? closes : null;
  }

  override async priceAt(
    symbol: string,
    at: Date,
  ): Promise<Prisma.Decimal | null> {
    const id = await this.idOf(symbol);
    if (!id) return null;
    const from = Math.floor((at.getTime() - 2 * 3_600_000) / 1000);
    const to = Math.floor((at.getTime() + 2 * 3_600_000) / 1000);
    const body = await this.get(
      `/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`,
    );
    let best: { gap: number; price: Prisma.Decimal } | null = null;
    for (const [time, price] of pricePoints(body)) {
      const gap = Math.abs(time - at.getTime());
      if (!best || gap < best.gap) best = { gap, price };
    }
    return best && best.gap <= MAX_POINT_GAP_MS ? best.price : null;
  }

  private async idOf(symbol: string): Promise<string | null> {
    const known = this.ids.get(symbol);
    if (known && known.expires > Date.now()) return known.id;
    await this.coins([symbol]); // apprend l'identifiant au passage
    return this.ids.get(symbol)?.id ?? null;
  }

  private async get(path: string): Promise<unknown> {
    const { apiKey, pro } = this.config;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey)
      headers[pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = apiKey;

    let response: Response;
    try {
      response = await fetch(
        `https://${pro ? 'pro-api' : 'api'}.coingecko.com/api/v3${path}`,
        { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
    } catch {
      throw new PriceUnavailableError();
    }
    // 429 : limite atteinte ; 401/403 : clé refusée ou historique hors de l'offre. Aucune ne dit que l'actif n'existe pas.
    if (!response.ok) throw new PriceUnavailableError();
    try {
      return await response.json();
    } catch {
      throw new PriceUnavailableError();
    }
  }
}

/** `{ prices: [[ms, prix], …] }` → points valides, du plus ancien au plus récent. */
function pricePoints(body: unknown): [number, Prisma.Decimal][] {
  const prices = (body as { prices?: unknown } | null)?.prices;
  if (!Array.isArray(prices)) throw new PriceUnavailableError();
  const points: [number, Prisma.Decimal][] = [];
  for (const point of prices as unknown[]) {
    if (!Array.isArray(point) || typeof point[0] !== 'number') continue;
    const price = positiveDecimal(point[1]);
    if (price) points.push([point[0], price]);
  }
  return points;
}
