import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  OrderOrigin,
  OrderSide,
  OrderStatus,
  OrderType,
  TradingMode,
} from '../../generated/prisma/enums.js';

/** Quantité : chaîne décimale strictement positive (jamais un nombre JSON, qui perdrait de la précision). */
const POSITIVE_DECIMAL = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,18})?$/;
const SYMBOL = /^[A-Z0-9]{2,12}$/;

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Ordre manuel : au marché, en mode PAPER uniquement. Les ordres LIVE viendront des signaux du moteur. */
export class CreateOrderDto {
  @ApiProperty({
    example: 'BTC',
    description: 'Actif de base ; la paire est <actif>/USDT',
  })
  @Transform(upper)
  @Matches(SYMBOL, { message: 'symbol invalide' })
  symbol: string;

  @ApiProperty({ enum: Object.values(OrderSide) })
  @IsEnum(OrderSide)
  side: OrderSide;

  @ApiProperty({
    example: '0.01',
    description:
      "Quantité d'actif de base : chaîne décimale > 0 (18 décimales max)",
  })
  @Matches(POSITIVE_DECIMAL, {
    message: 'quantity doit être une chaîne décimale strictement positive',
  })
  quantity: string;
}

export class OrderDto {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'Identifiant idempotent envoyé à la plateforme' })
  clientOrderId: string;
  @ApiProperty({ enum: Object.values(TradingMode) }) mode: TradingMode;
  @ApiProperty({ example: 'BTC/USDT' }) symbol: string;
  @ApiProperty({ enum: Object.values(OrderSide) }) side: OrderSide;
  @ApiProperty({ enum: Object.values(OrderType) }) type: OrderType;
  @ApiProperty({ enum: Object.values(OrderStatus) }) status: OrderStatus;
  @ApiProperty({
    enum: Object.values(OrderOrigin),
    description:
      'MANUAL, SIGNAL, ou sortie automatique STOP_LOSS / TAKE_PROFIT',
  })
  origin: OrderOrigin;
  @ApiProperty({ example: '0.01' }) quantity: string;
  @ApiProperty() filledQuantity: string;
  @ApiProperty({ nullable: true, type: String }) avgFillPrice: string | null;
  @ApiProperty({ nullable: true, type: String }) fee: string | null;
  @ApiProperty({ nullable: true, type: String }) feeCurrency: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Stop-loss programmé à l'exécution d'un achat",
  })
  stopLossPrice: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Take-profit programmé à l'exécution d'un achat",
  })
  takeProfitPrice: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Code du refus ou de l’échec (ex. exposure_exceeded, kill_switch)',
  })
  failureReason: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Pour une sortie : ordre d'entrée correspondant",
  })
  parentOrderId: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: Date }) executedAt: Date | null;
}

export class OrderListDto {
  @ApiProperty({ type: [OrderDto] }) items: OrderDto[];
}

export class ListOrdersQuery {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Pagination : ordres créés avant cette date (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;

  @ApiPropertyOptional({ enum: Object.values(OrderStatus) })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
