import { Module } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller.js';
import { PortfolioValuationService } from './portfolio-valuation.service.js';
import { PortfolioService } from './portfolio.service.js';
import { BinancePriceProvider } from './price/binance-price.provider.js';
import { PriceProvider } from './price/price-provider.js';

@Module({
  controllers: [PortfolioController],
  providers: [
    PortfolioService,
    PortfolioValuationService,
    // Remplaçable par une lecture du cache Redis sans toucher à la valorisation.
    { provide: PriceProvider, useClass: BinancePriceProvider },
  ],
  exports: [PortfolioService, PortfolioValuationService, PriceProvider],
})
export class PortfolioModule {}
