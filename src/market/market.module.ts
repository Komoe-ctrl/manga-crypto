import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoinGeckoSource } from './coingecko.source.js';
import { CoinMarketCapSource } from './coinmarketcap.source.js';
import { MarketController } from './market.controller.js';
import { MarketService } from './market.service.js';
import { MARKET_SOURCES, type MarketSource } from './market-source.js';

/**
 * CoinGecko fonctionne sans clé (API publique, plus limitée) ; CoinMarketCap n'est actif qu'avec `COINMARKETCAP_API_KEY`.
 * Les clés sont des clés du service, pas celles d'un utilisateur : elles ne sont jamais journalisées ni renvoyées.
 */
export function buildMarketSources(config: ConfigService): MarketSource[] {
  const sources: MarketSource[] = [
    new CoinGeckoSource({
      apiKey: config.get<string>('COINGECKO_API_KEY')?.trim() || undefined,
      pro: config.get<string>('COINGECKO_PLAN') === 'pro',
    }),
  ];
  const cmcKey = config.get<string>('COINMARKETCAP_API_KEY')?.trim();
  if (cmcKey) sources.push(new CoinMarketCapSource(cmcKey));
  return sources;
}

@Module({
  controllers: [MarketController],
  providers: [
    {
      provide: MARKET_SOURCES,
      inject: [ConfigService],
      useFactory: buildMarketSources,
    },
    MarketService,
  ],
  exports: [MARKET_SOURCES],
})
export class MarketModule {}
