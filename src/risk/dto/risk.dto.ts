import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const LIVE_CONFIRMATION = 'PASSER EN LIVE';

const percent = {
  maxDecimalPlaces: 2,
  allowNaN: false,
  allowInfinity: false,
} as const;

/** Tous les champs sont optionnels : seuls ceux fournis sont modifiés. Pourcentages à deux décimales (5 = 5 %). */
export class UpdateRiskSettingsDto {
  @ApiPropertyOptional({
    minimum: 0.01,
    maximum: 100,
    description: '% max du capital engagé sur une position',
  })
  @IsOptional()
  @IsNumber(percent)
  @Min(0.01)
  @Max(100)
  maxExposurePct?: number;

  @ApiPropertyOptional({
    minimum: 0.01,
    maximum: 100,
    description: 'Perte journalière max (%), au-delà : pause du robot',
  })
  @IsOptional()
  @IsNumber(percent)
  @Min(0.01)
  @Max(100)
  maxDailyLossPct?: number;

  @ApiPropertyOptional({
    minimum: 0.01,
    maximum: 100,
    description: 'Stop-loss par défaut (%)',
  })
  @IsOptional()
  @IsNumber(percent)
  @Min(0.01)
  @Max(100)
  defaultStopLossPct?: number;

  @ApiPropertyOptional({
    minimum: 0.01,
    maximum: 1000,
    description: 'Take-profit par défaut (%)',
  })
  @IsOptional()
  @IsNumber(percent)
  @Min(0.01)
  @Max(1000)
  defaultTakeProfitPct?: number;
}

export class RiskSettingsDto {
  @ApiProperty() maxExposurePct: number;
  @ApiProperty() maxDailyLossPct: number;
  @ApiProperty() defaultStopLossPct: number;
  @ApiProperty() defaultTakeProfitPct: number;
}

export class SwitchToLiveDto {
  @ApiProperty({
    writeOnly: true,
    description: 'Mot de passe du compte (ré-authentification)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;

  @ApiProperty({
    example: LIVE_CONFIRMATION,
    description: 'Phrase à recopier exactement',
  })
  @Equals(LIVE_CONFIRMATION, {
    message: `confirmation doit valoir « ${LIVE_CONFIRMATION} »`,
  })
  confirmation: string;
}

export type BlockedReason = 'KILL_SWITCH' | 'PAUSED_DAILY_LOSS';

export class TradingStatusDto {
  @ApiProperty({ enum: ['PAPER', 'LIVE'] }) tradingMode: string;
  @ApiProperty({ nullable: true, type: Date })
  tradingModeChangedAt: Date | null;
  @ApiProperty() killSwitchActive: boolean;
  @ApiProperty({ nullable: true, type: Date }) killSwitchAt: Date | null;
  @ApiProperty({ nullable: true, type: Date }) botPausedUntil: Date | null;
  @ApiProperty({
    description: 'Faux si le kill switch est actif ou si le robot est en pause',
  })
  canTrade: boolean;
  @ApiProperty({
    enum: ['KILL_SWITCH', 'PAUSED_DAILY_LOSS'],
    nullable: true,
    type: String,
  })
  blockedReason: BlockedReason | null;
}
