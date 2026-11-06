import { ApiProperty } from '@nestjs/swagger';

export class MarketCoinDto {
  @ApiProperty({ example: 'BTC' }) symbol: string;
  @ApiProperty({ example: 'Bitcoin' }) name: string;
  @ApiProperty({
    description: 'Prix en USD (décimal en texte)',
    example: '67250.12',
  })
  priceUsd: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Capitalisation en USD',
  })
  marketCapUsd: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: '1 = plus forte capitalisation',
  })
  rank: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Variation sur 24 h, en %',
    example: '-1.84',
  })
  change24hPct: string | null;
  @ApiProperty({ enum: ['coingecko', 'coinmarketcap'] })
  source: 'coingecko' | 'coinmarketcap';
}

export class MarketOverviewDto {
  @ApiProperty({ type: [MarketCoinDto] }) coins: MarketCoinDto[];
  @ApiProperty({
    type: [String],
    description: 'Symboles inconnus de toutes les sources',
  })
  unknown: string[];
  @ApiProperty({
    description:
      'Faux si une source en panne a pu priver la réponse de certains actifs',
  })
  complete: boolean;
}
