import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AssetValuationDto, PortfolioDto } from './dto/portfolio.dto.js';
import { PortfolioService } from './portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from './price/price-provider.js';
import { valuePortfolio, type PortfolioValuation } from './portfolio-math.js';

/** Valorisation en USD. Les prix indisponibles dégradent le résultat (`complete: false`), ils ne le font pas échouer. */
@Injectable()
export class PortfolioValuationService {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly prices: PriceProvider,
  ) {}

  async valuate(userId: string): Promise<PortfolioDto> {
    return toDto(await this.compute(userId));
  }

  /**
   * Valeur totale du portefeuille en USD, ou `null` si une position n'a pas pu être valorisée.
   * Destinée à la pause sur perte journalière : mieux vaut ne pas conclure qu'agir sur un total partiel.
   */
  async totalValue(userId: string): Promise<Prisma.Decimal | null> {
    const valuation = await this.compute(userId);
    return valuation.complete ? valuation.totalValue : null;
  }

  private async compute(userId: string): Promise<PortfolioValuation> {
    const holdings = await this.portfolio.list(userId);
    let prices = new Map<string, Prisma.Decimal | null>();
    if (holdings.length > 0) {
      try {
        prices = await this.prices.getPrices(holdings.map((h) => h.symbol));
      } catch (error) {
        if (!(error instanceof PriceUnavailableError)) throw error;
      }
    }
    return valuePortfolio(
      holdings.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        avgBuyPrice: h.avgBuyPrice,
        price: prices.get(h.symbol) ?? null,
      })),
    );
  }
}

/** Chaînes décimales en notation normale (jamais d'exposant), 8 décimales au plus. */
const str = (value: Prisma.Decimal): string =>
  value.toDecimalPlaces(8).toFixed();
const strOrNull = (value: Prisma.Decimal | null): string | null =>
  value ? str(value) : null;

function toDto(v: PortfolioValuation): PortfolioDto {
  return {
    currency: 'USD',
    assets: v.assets.map((a): AssetValuationDto => ({
      symbol: a.symbol,
      quantity: a.quantity.toFixed(),
      avgBuyPrice: a.avgBuyPrice.toFixed(),
      currentPrice: strOrNull(a.currentPrice),
      costBasis: str(a.costBasis),
      value: strOrNull(a.value),
      pnl: strOrNull(a.pnl),
      pnlPct: strOrNull(a.pnlPct),
      weightPct: strOrNull(a.weightPct),
    })),
    totalValue: str(v.totalValue),
    totalCost: str(v.totalCost),
    totalPnl: str(v.totalPnl),
    totalPnlPct: strOrNull(v.totalPnlPct),
    complete: v.complete,
  };
}
