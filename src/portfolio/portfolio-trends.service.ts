import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { STABLECOINS } from '../orders/order-rules.js';
import type { AssetTrendDto, TrendsDto } from './dto/portfolio.dto.js';
import { PortfolioService } from './portfolio.service.js';
import {
  PriceUnavailableError,
  PriceProvider,
} from './price/price-provider.js';
import {
  WEEK_HOURS,
  computeTrend,
  marketState,
  type AssetTrend,
} from './trends-math.js';

/** Au-delà, les actifs suivants sont ignorés (et la réponse marquée incomplète) : une requête de bougies par actif. */
const MAX_ASSETS = 30;

const str = (value: Prisma.Decimal): string =>
  value.toDecimalPlaces(8).toFixed();
const strOrNull = (value: Prisma.Decimal | null): string | null =>
  value ? value.toFixed() : null;

/**
 * Variations et courbes des actifs détenus, plus l'état du marché. Comme la valorisation, la panne d'une source ne fait
 * pas échouer la réponse : l'actif concerné est vide (`null`, courbe vide) et `complete` vaut `false`.
 */
@Injectable()
export class PortfolioTrendsService {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly prices: PriceProvider,
  ) {}

  async trends(userId: string): Promise<TrendsDto> {
    const holdings = await this.portfolio.list(userId);
    const symbols = holdings
      .map((h) => h.symbol)
      .filter((s) => !STABLECOINS.has(s));
    const shown = symbols.slice(0, MAX_ASSETS);
    // Le BTC sert à l'indicateur de marché même si l'utilisateur n'en détient pas.
    const wanted = [...new Set([...shown, 'BTC'])];

    const results = new Map<string, AssetTrend | null>(
      await Promise.all(
        wanted.map(async (symbol): Promise<[string, AssetTrend | null]> => {
          try {
            const closes = await this.prices.getHourlyCloses(
              symbol,
              WEEK_HOURS,
            );
            return [symbol, closes ? computeTrend(closes) : null];
          } catch (error) {
            if (!(error instanceof PriceUnavailableError)) throw error;
            return [symbol, null];
          }
        }),
      ),
    );

    const assets = shown.map((symbol): AssetTrendDto => {
      const trend = results.get(symbol) ?? null;
      return {
        symbol,
        change24hPct: strOrNull(trend?.change24hPct ?? null),
        change7dPct: strOrNull(trend?.change7dPct ?? null),
        sparkline: (trend?.sparkline ?? []).map(str),
      };
    });

    const btc24h = results.get('BTC')?.change24hPct ?? null;
    return {
      market: {
        state: marketState(btc24h),
        btcChange24hPct: strOrNull(btc24h),
      },
      assets,
      complete:
        symbols.length <= MAX_ASSETS &&
        assets.every((a) => a.sparkline.length > 0),
    };
  }
}
