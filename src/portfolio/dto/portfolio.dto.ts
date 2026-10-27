import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, Matches } from 'class-validator';

/** Quantité ou prix : chaîne décimale (jamais un nombre JSON, qui perdrait de la précision), strictement positive. */
const POSITIVE_DECIMAL = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,18})?$/;
const SYMBOL = /^[A-Z0-9]{2,12}$/;

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export enum TransactionSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export class RecordTransactionDto {
  @ApiProperty({ example: 'BTC' })
  @Transform(upper)
  @Matches(SYMBOL, { message: 'symbol invalide' })
  symbol: string;

  @ApiProperty({ enum: TransactionSide })
  @IsEnum(TransactionSide)
  side: TransactionSide;

  @ApiProperty({
    example: '0.015',
    description: 'Chaîne décimale > 0 (18 décimales max)',
  })
  @Matches(POSITIVE_DECIMAL, {
    message: 'quantity doit être une chaîne décimale strictement positive',
  })
  quantity: string;

  @ApiProperty({
    example: '64250.5',
    description: 'Prix unitaire en USD, chaîne décimale > 0',
  })
  @Matches(POSITIVE_DECIMAL, {
    message: 'price doit être une chaîne décimale strictement positive',
  })
  price: string;
}

/** Définit directement une position (import initial ou correction). */
export class SetAssetDto {
  @ApiProperty({ example: '0.5' })
  @Matches(POSITIVE_DECIMAL, {
    message: 'quantity doit être une chaîne décimale strictement positive',
  })
  quantity: string;

  @ApiProperty({ example: '60000', description: "Prix d'achat moyen en USD" })
  @Matches(POSITIVE_DECIMAL, {
    message: 'avgBuyPrice doit être une chaîne décimale strictement positive',
  })
  avgBuyPrice: string;
}

export class HoldingDto {
  @ApiProperty() symbol: string;
  @ApiProperty({ example: '0.5' }) quantity: string;
  @ApiProperty({ example: '60000' }) avgBuyPrice: string;
}

export class TransactionResultDto {
  @ApiProperty({
    nullable: true,
    type: HoldingDto,
    description: 'Position après la transaction ; null si soldée',
  })
  holding: HoldingDto | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Gain réalisé par une vente (USD)',
  })
  realizedPnl: string | null;
}

export class AssetValuationDto {
  @ApiProperty() symbol: string;
  @ApiProperty() quantity: string;
  @ApiProperty() avgBuyPrice: string;
  @ApiProperty({ nullable: true, type: String }) currentPrice: string | null;
  @ApiProperty() costBasis: string;
  @ApiProperty({ nullable: true, type: String }) value: string | null;
  @ApiProperty({ nullable: true, type: String }) pnl: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'En %' }) pnlPct:
    string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Part de la valeur totale, en %',
  })
  weightPct: string | null;
}

export class PortfolioDto {
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ type: [AssetValuationDto] }) assets: AssetValuationDto[];
  @ApiProperty({ description: 'Somme des positions valorisées' })
  totalValue: string;
  @ApiProperty() totalCost: string;
  @ApiProperty() totalPnl: string;
  @ApiProperty({ nullable: true, type: String }) totalPnlPct: string | null;
  @ApiProperty({
    description:
      'Faux si une position n’a pas pu être valorisée (totaux partiels)',
  })
  complete: boolean;
}

export class AssetTrendDto {
  @ApiProperty({ example: 'BTC' }) symbol: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '-1.35',
    description:
      'Variation sur 24 h, en % ; null si la source est indisponible ou si l’actif est coté depuis moins de 24 h',
  })
  change24hPct: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '4.2',
    description:
      'Variation sur 7 jours, en % ; null sans une semaine complète de données',
  })
  change7dPct: string | null;
  @ApiProperty({
    type: [String],
    description:
      'Prix de clôture horaires (au plus 42 points, du plus ancien au plus récent) ; vide si indisponible',
  })
  sparkline: string[];
}

export class MarketDto {
  @ApiProperty({
    // OpenAPI 3.0 : une énumération nullable doit contenir `null` dans ses valeurs, sinon les générateurs ignorent `nullable`.
    enum: ['UP', 'DOWN', 'CALM', null],
    nullable: true,
    description:
      'Indicateur descriptif d’après le BTC sur 24 h (±2 %) ; ce n’est pas un signal de trading. Null si indisponible',
  })
  state: 'UP' | 'DOWN' | 'CALM' | null;
  @ApiProperty({ nullable: true, type: String, example: '0.8' })
  btcChange24hPct: string | null;
}

export class TrendsDto {
  @ApiProperty({ type: MarketDto }) market: MarketDto;
  @ApiProperty({ type: [AssetTrendDto] }) assets: AssetTrendDto[];
  @ApiProperty({
    description:
      'Faux si une courbe est indisponible pour au moins un actif (réponse partielle)',
  })
  complete: boolean;
}
