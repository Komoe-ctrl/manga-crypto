import { Inject, Injectable, Logger } from '@nestjs/common';
import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import {
  MARKET_SOURCES,
  type MarketCoin,
  type MarketSource,
} from './market-source.js';

export interface MarketCoinView extends MarketCoin {
  /** Source qui a fourni cette ligne. */
  source: MarketSource['name'];
}

export interface MarketOverview {
  coins: MarketCoinView[];
  /** Symboles qu'aucune source ne connaît. */
  unknown: string[];
  /** Faux si une source en panne a pu priver la réponse de certains actifs. */
  complete: boolean;
}

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    @Inject(MARKET_SOURCES) private readonly sources: MarketSource[],
  ) {}

  /**
   * Données de marché des symboles demandés (même ordre). Chaque source complète ce que la précédente n'a pas
   * trouvé ; une source en panne est sautée, pas fatale.
   * @throws PriceUnavailableError si aucune source n'a pu répondre.
   */
  async overview(symbols: string[]): Promise<MarketOverview> {
    const found = new Map<string, MarketCoinView>();
    let answered = false;
    let failed = false;

    for (const source of this.sources) {
      const pending = symbols.filter((symbol) => !found.has(symbol));
      if (pending.length === 0) break;
      try {
        const coins = await source.coins(pending);
        answered = true;
        for (const [symbol, coin] of coins)
          found.set(symbol, { ...coin, source: source.name });
      } catch (error) {
        if (!(error instanceof PriceUnavailableError)) throw error;
        failed = true;
        this.logger.warn(`Source « ${source.name} » indisponible`);
      }
    }

    if (!answered) throw new PriceUnavailableError();
    const unknown = symbols.filter((symbol) => !found.has(symbol));
    return {
      coins: symbols.flatMap((symbol) => found.get(symbol) ?? []),
      unknown,
      complete: !(failed && unknown.length > 0),
    };
  }
}
