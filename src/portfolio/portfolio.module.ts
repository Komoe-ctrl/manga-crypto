import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module.js';
import { MARKET_SOURCES, type MarketSource } from '../market/market-source.js';
import { PortfolioController } from './portfolio.controller.js';
import { PortfolioTrendsService } from './portfolio-trends.service.js';
import { PortfolioValuationService } from './portfolio-valuation.service.js';
import { PortfolioService } from './portfolio.service.js';
import { BinancePriceProvider } from './price/binance-price.provider.js';
import {
  FallbackPriceProvider,
  MarketSourcePriceProvider,
} from './price/fallback-price.provider.js';
import { PriceProvider } from './price/price-provider.js';

@Module({
  imports: [MarketModule],
  controllers: [PortfolioController],
  providers: [
    PortfolioService,
    PortfolioValuationService,
    PortfolioTrendsService,
    // Binance d'abord (gratuit, sans clé), puis CoinGecko et CoinMarketCap si Binance est en panne ou ne connaît pas
    // l'actif. Remplaçable par une lecture du cache Redis sans toucher à la valorisation.
    {
      provide: PriceProvider,
      inject: [MARKET_SOURCES],
      useFactory: (sources: MarketSource[]) =>
        new FallbackPriceProvider([
          new BinancePriceProvider(),
          ...sources.map((source) => new MarketSourcePriceProvider(source)),
        ]),
    },
  ],
  exports: [PortfolioService, PortfolioValuationService, PriceProvider],
})
export class PortfolioModule {}
