import {
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import { MarketOverviewDto } from './dto/market.dto.js';
import { MarketService } from './market.service.js';
import { SymbolListPipe } from './symbol-list.pipe.js';

@ApiTags('market')
@ApiBearerAuth()
@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  /** Prix, capitalisation, rang et variation 24 h (CoinGecko, CoinMarketCap). Données publiques, pas de clé utilisateur. */
  @Get('coins')
  @ApiQuery({
    name: 'symbols',
    example: 'BTC,ETH',
    description: '1 à 25 symboles séparés par des virgules',
  })
  @ApiOkResponse({ type: MarketOverviewDto })
  async coins(@Query('symbols', SymbolListPipe) symbols: string[]) {
    try {
      const overview = await this.market.overview(symbols);
      return {
        ...overview,
        coins: overview.coins.map((coin) => ({
          ...coin,
          priceUsd: coin.priceUsd.toFixed(),
          marketCapUsd: coin.marketCapUsd?.toFixed() ?? null,
          change24hPct: coin.change24hPct?.toFixed() ?? null,
        })),
      };
    } catch (error) {
      if (error instanceof PriceUnavailableError)
        throw new ServiceUnavailableException(
          'Données de marché indisponibles : réessayez dans un instant',
        );
      throw error;
    }
  }
}
