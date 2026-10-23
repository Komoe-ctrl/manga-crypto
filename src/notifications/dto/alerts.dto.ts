import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Matches } from 'class-validator';
import {
  AlertCondition,
  NotificationChannel,
} from '../../generated/prisma/enums.js';

/** Seuil : chaîne décimale strictement positive (prix ou %, jamais un nombre JSON). */
const POSITIVE_DECIMAL = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,8})?$/;
const SYMBOL = /^[A-Z0-9]{2,12}$/;

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateAlertDto {
  @ApiPropertyOptional({
    example: 'BTC',
    description: 'Absent pour PORTFOLIO_DROP_PCT, requis sinon',
  })
  @IsOptional()
  @Transform(upper)
  @Matches(SYMBOL, { message: 'assetSymbol invalide' })
  assetSymbol?: string;

  @ApiProperty({ enum: Object.values(AlertCondition) })
  @IsEnum(AlertCondition)
  condition: AlertCondition;

  @ApiProperty({
    example: '5',
    description: '% pour les variations, prix en USD pour un franchissement',
  })
  @Matches(POSITIVE_DECIMAL, {
    message: 'threshold doit être une chaîne décimale strictement positive',
  })
  threshold: string;

  @ApiPropertyOptional({
    example: 60,
    description:
      'Fenêtre glissante en minutes (5 à 10080) ; requise pour une variation, interdite pour un franchissement',
  })
  @IsOptional()
  @IsInt()
  windowMinutes?: number;

  @ApiProperty({ enum: Object.values(NotificationChannel) })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Critique : passe même en Mode Nuit',
  })
  @IsOptional()
  @IsBoolean()
  isCritical?: boolean;
}

/** La condition et le symbole ne se modifient pas : créer une autre alerte. */
export class UpdateAlertDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(POSITIVE_DECIMAL, {
    message: 'threshold doit être une chaîne décimale strictement positive',
  })
  threshold?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() windowMinutes?: number;
  @ApiPropertyOptional({ enum: Object.values(NotificationChannel) })
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isCritical?: boolean;
}

export class AlertDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) assetSymbol: string | null;
  @ApiProperty({ enum: Object.values(AlertCondition) })
  condition: AlertCondition;
  @ApiProperty() threshold: string;
  @ApiProperty({ nullable: true, type: Number }) windowMinutes: number | null;
  @ApiProperty({ enum: Object.values(NotificationChannel) })
  channel: NotificationChannel;
  @ApiProperty() isActive: boolean;
  @ApiProperty() isCritical: boolean;
  @ApiProperty({ nullable: true, type: Date }) lastTriggeredAt: Date | null;
  @ApiProperty() createdAt: Date;
}
