import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Exchange, ExchangeStatus } from '../../generated/prisma/enums.js';

export class CreateExchangeConfigDto {
  @ApiProperty({ enum: Object.values(Exchange) })
  @IsEnum(Exchange)
  exchange: Exchange;

  @ApiProperty({ example: 'Binance principal' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label: string;

  /** Clé publique. Chiffrée avant stockage, jamais renvoyée. */
  @ApiProperty({ writeOnly: true })
  @IsString()
  @Matches(/^\S{8,256}$/, { message: 'apiKey invalide' })
  apiKey: string;

  /** Secret. Chiffré avant stockage, jamais renvoyé. */
  @ApiProperty({ writeOnly: true })
  @IsString()
  @Matches(/^\S{8,256}$/, { message: 'apiSecret invalide' })
  apiSecret: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Testnet : permissions non vérifiables, jamais utilisable en LIVE',
  })
  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;
}

/** Vue publique d'une configuration : aucun champ chiffré, aucune clé. */
export class ExchangeConfigDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: Object.values(Exchange) }) exchange: Exchange;
  @ApiProperty() label: string;
  @ApiProperty() sandbox: boolean;
  @ApiProperty({ enum: Object.values(ExchangeStatus) }) status: ExchangeStatus;
  @ApiProperty({ nullable: true, type: String }) statusReason: string | null;
  @ApiProperty({ type: [String], example: ['read', 'trade'] })
  permissions: string[];
  @ApiProperty({
    description: '4 derniers caractères de la clé',
    example: 'a1b2',
  })
  apiKeyHint: string;
  @ApiProperty({ nullable: true, type: Date }) verifiedAt: Date | null;
  @ApiProperty() createdAt: Date;
}
